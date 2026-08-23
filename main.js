const MODULE_ID = 'bunny-hop';
const SOCKET_EVENT = `module.${MODULE_ID}`; 	//module.bunny-hop

// 注册fvtt配置设定
Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'moveSpeedSeconds', {
        name: '移动速度（秒/格）',
        hint: 'Token 跳跃一格所需的时间，数值越小跳得越快。',
        scope: 'world',
        config: true,
        type: Number,
        default: 0.3,
        range: { min: 0.05, max: 3, step: 0.05 }
    });

    game.settings.register(MODULE_ID, 'jumpScaleFactor', {
        name: '缩放倍数',
        hint: '跳跃最高点时 Token 的放大倍数（1=不缩放）。',
        scope: 'client',
        config: true,
        type: Number,
        default: 1.4,
        range: { min: 1, max: 3.0, step: 0.05 }
    });

    game.settings.register(MODULE_ID, 'stepDelayMs', {
        name: '停顿时间（毫秒）',
        hint: '每跳完一格后的停顿时间，数值越大节奏越慢。',
        scope: 'world',
        config: true,
        type: Number,
        default: 50,
        range: { min: 0, max: 500, step: 10 }
    });

    game.settings.register(MODULE_ID, 'maxRotationDeg', {
        name: '旋转角度',
        hint: '跳跃过程中 Token 旋转的最大幅度（0 = 不旋转）。',
        scope: 'client',
        config: true,
        type: Number,
        default: 22.5,
        range: { min: 0, max: 90, step: 0.5 }
    });
});
// ============================================================
// 配置
// ============================================================
let MOVE_SPEED_SECONDS; // 每格动画时长（秒）
let JUMP_SCALE_FACTOR;  // 跳跃缩放倍数
let STEP_DELAY_MS;      // 每格之间的停顿（毫秒）
let MAX_ROTATION;      // 最大旋转角度
window.bunnyHopDebug = false;

// ============================================================
// 全局锁
// ============================================================
const _movingTokens = new Set();   // 动画锁 阻止Token移动期间再次拖拽
const _updatingTokens = new Set(); // 更新锁 阻止document.update触发的钩子

// ============================================================
// 核心动画函数（每格跳跃）
// ============================================================
function animateHop(token, startX, startY, endX, endY) {
    const mesh = token.mesh;
    if (!mesh) return Promise.resolve();
    const sizeX = canvas?.grid?.sizeX ?? 100;   //网格宽度（像素）
    const sizeY = canvas?.grid?.sizeY ?? 100;   //网格高度（像素）
    const duration = Math.max(MOVE_SPEED_SECONDS * 1000, 1); // 至少 1ms
    const tokenRot = token.document.rotation * Math.PI / 180;    //token当前弧度
    const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    return new Promise((resolve) => {
        const startTime = performance.now();
        const baseMeshScaleX = mesh.scale.x;
        const baseMeshScaleY = mesh.scale.y;

        function tick() {
            const elapsed = performance.now() - startTime;
            let p = Math.min(elapsed / duration, 1);
            const e = easeInOutQuad(p);

            const toX = startX + (endX - startX) * e;
            const toY = startY + (endY - startY) * p;

            // 位置 
            token.position.set(toX, toY);
            mesh.position.x = toX + sizeX/2*token.document.width;
            mesh.position.y = toY + sizeY/2*token.document.height;

            // 旋转
            if(startX < endX){  //向右走
                mesh.rotation =  tokenRot + MAX_ROTATION * Math.sin(Math.PI * p);
            }else if(startX > endX){    //向左走
                mesh.rotation =  tokenRot - MAX_ROTATION * Math.sin(Math.PI * p);
            } 

            // 缩放
            const scaleJump = 1 + (JUMP_SCALE_FACTOR - 1) * Math.sin(Math.PI * p);
            mesh.scale.set(baseMeshScaleX * scaleJump, baseMeshScaleY * scaleJump);

            if (p >= 1) {
                token.position.set(endX, endY);
                resolve();
            } else {
                requestAnimationFrame(tick);
            }
        }

        requestAnimationFrame(tick);
    });
}

// ============================================================
// 路径播放器（逐格跳跃）
// ============================================================
async function playHopPath(token, waypoints) {

    //循环单格移动
    try {
        // 确保起点
        token.position.set(waypoints[0].x, waypoints[0].y);

        for (let i = 0; i < waypoints.length - 1; i++) {
            const from = waypoints[i];
            const to = waypoints[i + 1];

            await animateHop(token, from.x, from.y, to.x, to.y);

            // 如果不是最后一格，停顿
            if (i < waypoints.length - 2) {
                await new Promise(resolve => setTimeout(resolve, STEP_DELAY_MS));
            }
        }
        if(window.bunnyHopDebug) console.log("✅ 逐格动画完成，终点:", waypoints[waypoints.length - 1]);
    } catch (err) {
        if(window.bunnyHopDebug) console.error("❌ playHopPath 出错:", err);
        throw err
    }
}

// ============================================================
// preMoveToken 钩子（核心）
// ============================================================
function handleTokenMoveStep(tokenDocument, movementData, operation) {
    const tokenId = tokenDocument.id;
    if(window.bunnyHopDebug){	//debug
        window.bunnyHopDebug_tokenDocument = tokenDocument;
        window.bunnyHopDebug_movementDatamovementData;
        window.bunnyHopDebug_operation = operation;
    }

    // 如果该 Token 正在执行自己的 document.update，放行
    if (_updatingTokens.has(tokenId)) {
        return; 
    }

    // 不是用户拖拽发起的移动，放行
    if (Object.values(operation.movement)[0].method !== "dragging") {
        return; 
    }

    // 如果该 Token 正在播放动画，阻止新移动
    if (_movingTokens.has(tokenId)) {
        if(window.bunnyHopDebug) console.log(`⏭️ Token: ${tokenId} 正在动画中，阻止新拖拽`);
        return false;
    }

    const token = canvas.tokens.get(tokenDocument.id);
    if (!token) {
        if(window.bunnyHopDebug) console.warn("❌ Token 不在场景");
        return false;
    }

    // 提取路径
    const origin = movementData.origin;
    const waypoints = movementData.passed?.waypoints || [];
    if (!origin || waypoints.length === 0) {
        if(window.bunnyHopDebug) console.warn("❌ 无有效路径");
        return false;
    }
    const pending = movementData.pending?.waypoints || [];
    const lastPoint = pending.length>0? pending[pending.length - 1]:waypoints[waypoints.length - 1];

    // 锁定该Token，防止并发
    _movingTokens.add(tokenId);

    const fullPath = [origin, ...waypoints, ...pending].map(p => ({x: p.x, y: p.y}));
    if(window.bunnyHopDebug) console.log(`📌 完整路径（${fullPath.length} 个点）`);


	// 广播给其他用户
	game.socket.emit(SOCKET_EVENT, {tokenId: tokenDocument.id, fullPath: fullPath});

    // 异步播放动画（不等待，钩子立即返回 false）
    playHopPath(token, fullPath)
        .then(() => {
            // 动画完成后，更新 document 到终点
            if(window.bunnyHopDebug) console.log("🔄 动画完成,更新 document 到终点...");
            _updatingTokens.add(tokenId);   
            token.document.update({ x: lastPoint.x, y: lastPoint.y },{ animate: false })
            .then(() => {
                if(window.bunnyHopDebug) console.log("✅ document 已同步");
            }).catch(err => {
                if(window.bunnyHopDebug) console.error("❌ document 更新失败:", err);
            }).finally(() => {
                _updatingTokens.delete(tokenId);
            });
        })
        .catch(err => {
            if(window.bunnyHopDebug) console.error("❌ 动画播放失败:", err);
        })
        .finally(() => {
            // 释放动画锁
            _movingTokens.delete(tokenId);
        });

    // 阻止FVTT原版移动
    return false;
}

// ============================================================
// 注册钩子
// ============================================================
Hooks.once('ready', () => {
    // 读取配置
    MOVE_SPEED_SECONDS = game.settings.get(MODULE_ID, 'moveSpeedSeconds');
    JUMP_SCALE_FACTOR = game.settings.get(MODULE_ID, 'jumpScaleFactor');
    STEP_DELAY_MS = game.settings.get(MODULE_ID, 'stepDelayMs');
    MAX_ROTATION = game.settings.get(MODULE_ID, 'maxRotationDeg') * Math.PI / 180;


	// 注册 Socket 事件
	game.socket.on(SOCKET_EVENT, (data) => {
		const { tokenId, fullPath } = data;
        const token = canvas.tokens.get(tokenId);
        if(!token){
            if(window.bunnyHopDebug) console.warn(`Token:${tokenId} 不在画布上`);
            return;
        }

        // 锁定该Token，防止并发
        _movingTokens.add(tokenId);
	    //移动token
	    playHopPath(token, fullPath)
        .then(() => {
            if(window.bunnyHopDebug) console.log("🔄 远程动画完成");
        })
        .catch(err => {
            if(window.bunnyHopDebug) console.error("❌ 远程动画播放失败:", err);
        })
        .finally(() => {
            _movingTokens.delete(tokenId);
        });

	});
    console.log(`✅ bunny-hop.Socket 事件 ${SOCKET_EVENT} 监听已注册`);

    
    // 注册钩子
    Hooks.off("preMoveToken", handleTokenMoveStep); // 清除旧监听
	Hooks.on("preMoveToken", handleTokenMoveStep);
    console.log('✅ bunny-hop 模组已加载。');

});








