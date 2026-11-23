/**
 * physics.js —— 四旋翼飞行物理（纯逻辑模块）
 *
 * 硬性约束：本模块不 import 任何 Three.js / 渲染相关内容。
 *   输入：输入状态对象 + 碰撞世界（地图碰撞数据）+ 物理状态
 *   输出：新的物理状态（纯普通对象，不修改传入的旧状态）
 * 因此可以直接在 Node 中做单元测试，或替换任意渲染引擎。
 *
 * 单位与坐标：米、米/秒、弧度；y-up。
 * 机体约定：
 *   - yaw = 0 时机头朝 +Z，机体右侧为 -X
 *   - pitch > 0：机头下压（向前加速）
 *   - roll  > 0：向右倾斜（向右加速）
 *   - yaw 增大：俯视逆时针（向左转）
 *   - 欧拉角顺序 YXZ（先偏航、再俯仰、再横滚），与渲染端保持一致
 *   - angularVelocity 为欧拉角速率：x = d(pitch)/dt，y = d(yaw)/dt，z = d(roll)/dt
 *
 * 输入状态对象（来自 controls.js）：
 *   { throttle: 0~1, pitch: -1~1, roll: -1~1, yaw: -1~1 }
 *   throttle = 0.5 为悬停推力；pitch +1 = 前进；roll +1 = 右移；yaw +1 = 右转
 */

const DEG = Math.PI / 180;

/** 全部物理常量集中于此，便于调参（角度值均为弧度） */
export const PHYSICS_CONFIG = {
    fixedTimeStep: 1 / 120,         // 固定物理步长（秒）
    maxFrameTime: 0.25,             // 单帧最多追赶的物理时间，防止卡顿后“死亡螺旋”

    gravity: 9.81,                  // m/s²
    mass: 1.2,                      // kg
    maxThrust: 1.2 * 9.81 * 2.0,    // N，推重比 2:1
    droneRadius: 0.5,               // 碰撞包围球半径（m）

    linearDamping: {
        // 线性阻尼（1/s），a -= k * v
        horizontal: 0.35,
        vertical: 1.2,
    },

    maxTilt: 25 * DEG,              // 最大倾角 25°
    tiltStiffness: 60,              // 姿态回复刚度（rad/s² 每 rad 误差）
    angularDamping: 11,             // 角速度阻尼（1/s）
    unpoweredAngularDamping: 1.5,   // 断电后仅剩空气阻尼
    maxYawRate: 100 * DEG,          // 最大偏航角速度（rad/s）
    yawResponse: 5,                 // 偏航角速度跟随速率（1/s）
    tiltCompensationMinCos: 0.6,    // 倾斜时推力补偿的下限，避免除零

    // 悬停辅助：松杆时自动反向倾斜抵消水平速度，实现“松杆回中、悬停不漂移”
    hoverAssist: {
        enabled: true,
        gain: 0.08,                 // 每 m/s 速度对应的反向倾角（rad）
        maxTilt: 18 * DEG,          // 刹车时允许的最大倾角
    },

    batteryCapacity: 100,           // 电量（%）
    hoverEndurance: 240,            // 满电悬停时长（秒）≈ 4 分钟；耗电与推力（油门）成正比

    collision: {
        skin: 0.01,                 // 接触容差（m），用于稳定判定“着地”
        landingSpeed: 2.5,          // 法向速度低于此值视为“低速触地” → 停住
        landingHorizontalSpeed: 2.0,// 同时水平速度低于此值才算“垂直”触地
        restitution: 0.35,          // 反弹系数
        tangentialDamping: 0.7,     // 反弹时切向速度保留比例
        minBounceSpeed: 0.4,        // 低于此反弹速度直接吸收，避免抖动
        groundFriction: 6,          // 停在地面/平台上时的水平摩擦（1/s）
        groundLeveling: 8,          // 着地后机身回平速率（1/s）
        floorNormalY: 0.7,          // 法线 y 分量大于此值的接触面视为“地面/平台”
        impactFeedbackThreshold: 0.8, // 超过此冲击速度才计为一次“碰撞”反馈
    },
};

/* ------------------------------------------------------------------ */
/* 碰撞世界                                                            */
/* ------------------------------------------------------------------ */

/**
 * 由地图碰撞数据（MapData.collision）构建物理使用的碰撞世界。
 * @param {{terrain:{type:string}, bounds:{x:number[], z:number[]}, wind?:object,
 *          colliders:{min:{x,y,z}, max:{x,y,z}}[]}} collisionData
 */
export function createCollisionWorld(collisionData) {
    return {
        getGroundHeight: createGroundHeightSampler(collisionData.terrain),
        colliders: collisionData.colliders || [],
        bounds: collisionData.bounds,
        // 风：V1 仅读取保留，不参与物理（见 step() 中的 [WIND] 接入点）
        wind: collisionData.wind || { direction: 0, strength: 0 },
    };
}

/** 地面高度采样器：getGroundHeight(x, z) -> y */
function createGroundHeightSampler(terrain) {
    switch (terrain && terrain.type) {
        case "flat":
            return (_x, _z) => 0; // 规范：flat 地形恒为 y = 0

        // 未来：case 'heightmap': return (x, z) => sampleHeightmap(terrain, x, z);
        default:
            throw new Error(`不支持的地形类型：${terrain && terrain.type}`);
    }
}

/** 是否越出飞行区域（仅用于提示，不做硬墙） */
export function isOutOfBounds(position, bounds) {
    if (!bounds)
        return false;

    return (
        position.x < bounds.x[0] ||
        position.x > bounds.x[1] ||
        position.z < bounds.z[0] ||
        position.z > bounds.z[1]
    );
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

/**
 * 初始物理状态（R 重置时同样调用）
 * @param {{position:{x,y,z}, rotation:number}} spawn  rotation 为 yaw（弧度）
 */
export function createInitialState(spawn) {
    return {
        position: {
            x: spawn.position.x,
            y: spawn.position.y,
            z: spawn.position.z,
        },
        velocity: { x: 0, y: 0, z: 0 },
        pitch: 0,
        roll: 0,
        yaw: spawn.rotation,
        angularVelocity: { x: 0, y: 0, z: 0 },

        // —— 以下为扩展字段（同样是纯数据）——
        battery: PHYSICS_CONFIG.batteryCapacity, // 剩余电量（%）
        thrust: 0,          // 当前总推力（N）
        motorOutput: 0,     // 推力 / 最大推力（0~1），供渲染螺旋桨转速使用
        grounded: false,    // 本步是否与地面/平台接触
        crashed: false,     // 电量耗尽后触地 → 坠机（R 重置前保持）
        collisionCount: 0,  // 累计碰撞反馈次数（渲染/HUD 通过其变化感知碰撞）
        lastImpactSpeed: 0, // 最近一次碰撞的冲击速度（m/s）
        time: 0,
    };
}

function cloneState(s) {
    return {
        ...s,
        position: { ...s.position },
        velocity: { ...s.velocity },
        angularVelocity: { ...s.angularVelocity },
    };
}

/* ------------------------------------------------------------------ */
/* 单步推进                                                            */
/* ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num   = (v, fallback) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

function sanitizeInput(input) {
    const i = input || {};

    return {
        throttle : clamp(num(i.throttle, 0.5), 0, 1),
        pitch    : clamp(num(i.pitch, 0), -1, 1),
        roll     : clamp(num(i.roll, 0), -1, 1),
        yaw      : clamp(num(i.yaw, 0), -1, 1),
    };
}

/** 机体“上”方向在世界坐标中的单位向量（欧拉顺序 YXZ） */
function bodyUp(pitch, roll, yaw) {
    const sp = Math.sin(pitch),
        cp = Math.cos(pitch);
    const sr = Math.sin(roll),
        cr = Math.cos(roll);
    const sy = Math.sin(yaw),
        cy = Math.cos(yaw);

    return {
        x: -sr * cy + cr * sp * sy,
        y: cr * cp,
        z: sr * sy + cr * sp * cy,
    };
}

/**
 * 推进一个固定时间步。
 * @param {object} state  当前物理状态（不会被修改）
 * @param {{throttle:number,pitch:number,roll:number,yaw:number}} input
 * @param {object} world  createCollisionWorld() 的返回值
 * @param {number} dt     时间步（秒），通常为 PHYSICS_CONFIG.fixedTimeStep
 * @returns {object} 新的物理状态
 */
export function step(state, input, world, dt) {
    const C = PHYSICS_CONFIG;
    const inp = sanitizeInput(input);
    const s = cloneState(state);
    const weight = C.mass * C.gravity;
    let powered = s.battery > 0;

    /* 1. 推力：throttle 0 → 0，0.5 → 悬停，1 → 最大推力；并做倾斜补偿 */
    let thrust = 0;
    if (powered) {
        const t = inp.throttle;
        const base =
            t <= 0.5
                ? weight * (t / 0.5)
                : weight + (C.maxThrust - weight) * ((t - 0.5) / 0.5);
        const tiltCos = Math.max(
            Math.cos(s.pitch) * Math.cos(s.roll),
            C.tiltCompensationMinCos,
        );

        thrust = Math.min(base / tiltCos, C.maxThrust);
    }

    // 电量消耗与推力（油门）正相关；悬停推力下约 240 秒耗尽。
    // 在运动积分之前处理，确保电量归零的同一步就立即失去推力。
    if (powered) {
        const drainPerSec =
            (C.batteryCapacity / C.hoverEndurance) * (thrust / weight);
        s.battery = Math.max(0, s.battery - drainPerSec * dt);

        if (s.battery === 0) {
            thrust = 0;
            powered = false;
        }
    }
    // 停在地面/平台上且推力不足以起飞：机身不倾斜、不偏航
    const resting = state.grounded && thrust <= weight * 1.001;

    /* 2. 姿态：弹簧-阻尼跟随目标倾角，偏航为角速度控制 */
    const av = s.angularVelocity;
    if (powered) {
        let targetPitch = 0,
            targetRoll = 0,
            targetYawRate = 0;

        if (!resting) {
            targetPitch = inp.pitch * C.maxTilt;
            targetRoll = inp.roll * C.maxTilt;

            if (C.hoverAssist.enabled) {
                const sy = Math.sin(s.yaw),
                    cy = Math.cos(s.yaw);
                const vForward = s.velocity.x * sy + s.velocity.z * cy;
                const vRight = -s.velocity.x * cy + s.velocity.z * sy;
                const lim = C.hoverAssist.maxTilt;
                const brakePitch = clamp(
                    -vForward * C.hoverAssist.gain,
                    -lim,
                    lim,
                );
                const brakeRoll = clamp(
                    -vRight * C.hoverAssist.gain,
                    -lim,
                    lim,
                );

                targetPitch += (1 - Math.abs(inp.pitch)) * brakePitch;
                targetRoll  += (1 - Math.abs(inp.roll)) * brakeRoll;
            }

            targetYawRate = -inp.yaw * C.maxYawRate;
        }

        av.x +=
            (C.tiltStiffness * (targetPitch - s.pitch) -
                C.angularDamping * av.x) * dt;

        av.z +=
            (C.tiltStiffness * (targetRoll - s.roll) -
                C.angularDamping * av.z) * dt;

        av.y += (targetYawRate - av.y) * (1 - Math.exp(-C.yawResponse * dt));
    } else {
        const decay = Math.exp(-C.unpoweredAngularDamping * dt);
        av.x *= decay;
        av.y *= decay;
        av.z *= decay;
    }

    s.pitch += av.x * dt;
    s.roll  += av.z * dt;

    // 限制弹簧响应可能产生的微小超调，各倾斜轴不超过配置的 25°。
    if (Math.abs(s.pitch) > C.maxTilt) {
        s.pitch = clamp(s.pitch, -C.maxTilt, C.maxTilt);
        if (s.pitch * av.x > 0)
            av.x = 0;
    }

    if (Math.abs(s.roll) > C.maxTilt) {
        s.roll = clamp(s.roll, -C.maxTilt, C.maxTilt);
        if (s.roll * av.z > 0)
            av.z = 0;
    }

    s.yaw += av.y * dt;

    /* 3. 线运动：推力 + 重力 + 线性阻尼（半隐式欧拉） */
    const up = bodyUp(s.pitch, s.roll, s.yaw);
    const accel = thrust / C.mass;
    const v = s.velocity;
    let ax = up.x * accel - C.linearDamping.horizontal * v.x;
    let ay = up.y * accel - C.gravity - C.linearDamping.vertical * v.y;
    let az = up.z * accel - C.linearDamping.horizontal * v.z;

    // [WIND] 风的接入点：V1 只读取 world.wind（direction 弧度 / strength m/s）而不应用。
    // 未来可在此加入：ax += k * (windVx - v.x); az += k * (windVz - v.z);
    v.x += ax * dt;
    v.y += ay * dt;
    v.z += az * dt;

    const p = s.position;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    /* 4. 碰撞：地面 + 障碍物 AABB（包围球半径 r） */
    const contact = { grounded: false, impacts: 0, maxImpact: 0 };
    const r = C.droneRadius;
    const skin = C.collision.skin;

    const groundY = world.getGroundHeight(p.x, p.z);
    if (p.y - r < groundY + skin) {
        resolveContact(s, 0, 1, 0, Math.max(0, groundY + r - p.y), contact);
    }

    for (const box of world.colliders) {
        collideSphereAabb(s, box, r, skin, contact);
    }

    /* 5. 接地后的摩擦与回平 */
    if (contact.grounded && thrust <= weight * 1.001) {
        const f = Math.exp(-C.collision.groundFriction * dt);
        v.x *= f;
        v.z *= f;

        const l = Math.exp(-C.collision.groundLeveling * dt);
        s.pitch *= l;
        s.roll  *= l;
        av.x    *= l;
        av.z    *= l;
        av.y    *= l;
    }

    s.thrust = thrust;
    s.motorOutput = thrust / C.maxThrust;
    s.grounded = contact.grounded;
    s.crashed = state.crashed || (s.battery <= 0 && contact.grounded);
    if (contact.impacts > 0) {
        s.collisionCount = state.collisionCount + 1;
        s.lastImpactSpeed = contact.maxImpact;
    }

    s.time = state.time + dt;

    return s;
}

/* ------------------------------------------------------------------ */
/* 碰撞求解                                                            */
/* ------------------------------------------------------------------ */

/** 球体 vs 轴对齐包围盒 */
function collideSphereAabb(s, box, r, skin, contact) {
    const p  = s.position;
    const cx = clamp(p.x, box.min.x, box.max.x);
    const cy = clamp(p.y, box.min.y, box.max.y);
    const cz = clamp(p.z, box.min.z, box.max.z);
    const dx = p.x - cx,
          dy = p.y - cy,
          dz = p.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const reach = r + skin;

    if (d2 > reach * reach)
        return;

    if (d2 > 1e-12) {
        // 球心在盒外：沿最近点方向推出
        const d = Math.sqrt(d2);
        resolveContact(s, dx / d, dy / d, dz / d, Math.max(0, r - d), contact);
        return;
    }

    // 球心已进入盒内：沿穿透最浅的面推出
    const candidates = [
        [p.x - box.min.x, -1,  0, 0],
        [box.max.x - p.x,  1,  0, 0],
        [p.y - box.min.y,  0, -1, 0],
        [box.max.y - p.y,  0,  1, 0],
        [p.z - box.min.z,  0,  0, -1],
        [box.max.z - p.z,  0,  0, 1],
    ];

    let best = candidates[0];

    for (const c of candidates)
        if (c[0] < best[0])
            best = c;

    resolveContact(s, best[1], best[2], best[3], best[0] + r, contact);
}

/**
 * 接触响应：位置推出 + 速度处理
 *   - 地面/平台 + 垂直低速 → 停住（去掉法向速度）
 *   - 其他情况 → 衰减反弹
 */
function resolveContact(s, nx, ny, nz, depth, contact) {
    const C = PHYSICS_CONFIG.collision;
    const p = s.position,
          v = s.velocity;

    p.x += nx * depth;
    p.y += ny * depth;
    p.z += nz * depth;

    const isFloor = ny >= C.floorNormalY;
    if (isFloor)
        contact.grounded = true;

    const vn = v.x * nx + v.y * ny + v.z * nz;
    if (vn >= 0)
        return; // 已在分离

    const impact = -vn;
    const tx = v.x - vn * nx,
        ty = v.y - vn * ny,
        tz = v.z - vn * nz;
    const tangentialSpeed = Math.sqrt(tx * tx + ty * ty + tz * tz);

    if (
        isFloor &&
        impact <= C.landingSpeed &&
        tangentialSpeed <= C.landingHorizontalSpeed
    ) {
        v.x = tx;
        v.y = ty;
        v.z = tz; // 停住

        return;
    }

    let bounce = impact * C.restitution;
    if (bounce < C.minBounceSpeed)
        bounce = 0;

    v.x = tx * C.tangentialDamping + nx * bounce;
    v.y = ty * C.tangentialDamping + ny * bounce;
    v.z = tz * C.tangentialDamping + nz * bounce;

    if (impact >= C.impactFeedbackThreshold) {
        contact.impacts++;
        if (impact > contact.maxImpact)
            contact.maxImpact = impact;
    }
}
