import * as THREE from 'three';
import { State, DrawMode } from './LineManager.js';

/**
 * DrawingController - 交互控制器
 *
 * 状态机：
 *   IDLE → HOVERING → PENDING → DRAWING → IDLE
 *
 * 绘制模式：
 *   FREEHAND - 随手画，连续记录轨迹点
 *   STRAIGHT  - 直线，只记录首尾两点，实时预览
 *   CURVE     - 曲线，随手画后 CatmullRom 平滑
 *
 * 端点吸附：
 *   - 绘制过程中，鼠标进入端点范围 → 显示吸附环
 *   - 松开时若在端点上 → 最后一点精确吸附到端点
 *   - 无需拖拽直接点击端点 → 进入 PENDING 续画模式
 */

export { State, DrawMode };

export class DrawingController {
  constructor({ canvas, camera, lineManager, scene, onStateChange, polygonPicker, onPolygonPicked, linePicker, onLinePicked, onLineFinalized, onMeasure, onMultiSelect }) {
    this.canvas = canvas;
    this.camera = camera;
    this.lineManager = lineManager;
    this.scene = scene;
    this.onStateChange = onStateChange;

    this.state = State.IDLE;
    this.currentLineId = null;
    this.hasDragged = false;

    // PENDING 暂存
    this.pendingEndpointPosition = null;
    this.pendingEndpointKey = null;

    // 端点吸附（绘制中）
    this.snapTarget = null; // { key, position, mesh }

    // ★ 记录起/终点吸附到的已知端点 key，供 finalizeLineWithSnap 直接复用
    this._snapStartKey = null;
    this._snapEndKey = null;

    // ★ 鼠标悬浮线条 id
    this._hoveredLineId = null;

    // 直线模式下的临时终点
    this.straightTempPoint = null;

    // 射线
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 0.1;
    this.raycaster.params.Line = { threshold: 0.15 };

    // 鼠标
    this.mouse = new THREE.Vector2();
    this.isMouseDown = false;
    this.mouseDownPos = new THREE.Vector2();
    this.dragThreshold = 3;

    // 投影平面（自由绘制用，垂直于视线）
    this.projectionPlane = new THREE.Plane();

    // Z 轴吸附起点（由 main.js 在点击 Z 轴时设置）
    this._snapStartPoint = null;

    // ★ 绘制开关：预览模式置 false 时忽略一切绘制交互
    this.enabled = true;

    // ★ 锁定绘制平面：开启后所有绘制点投影到 lockedPlane，保证共面
    this.planeLocked = false;
    this.lockedPlane = null;

    // ★ 自由绘制时的投影面模式：
    //   'camera'    - 投影到正对相机的平面（默认，笔触正对镜头）
    //   'horizontal'- 投影到水平面 XZ（真实3D水平笔触，旋转相机可在不同高度叠层）
    this.freePlaneMode = 'camera';

    // 笔刷模式
    this.brushMode = false;
    /** @type {import('./BrushManager.js').BrushManager|null} */
    this.brushManager = null;
    this._brushDrawing = false;
    this._brushLastPos = null;

    // 辅助多边形拾取（由 main.js 提供；返回 { group, point } 或 null）
    this.polygonPicker = polygonPicker || null;
    this.onPolygonPicked = onPolygonPicked || null;

    // 线条拾取 / 选中回调（单条线条选中用）
    this.linePicker = linePicker || null;
    this.onLinePicked = onLinePicked || null;
    this.onLineFinalized = onLineFinalized || null;
    this.onMeasure = onMeasure || null;
    this.onMultiSelect = onMultiSelect || null;

    this.bindEvents();
  }

  /** 启用 / 禁用绘制（编辑 / 预览模式切换） */
  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.isMouseDown = false;
      if (this.state === State.DRAWING || this.state === State.PENDING) {
        this.currentLineId = null;
        this.lineManager.unhighlightEndpoint();
        this.lineManager.hideSnapIndicator();
        this.lineManager.clearSnapGrow();
        this.transitionTo(State.IDLE);
      }
    }
  }

  /** 切换笔刷模式 */
  setBrushMode(on, brushMgr) {
    this.brushMode = !!on;
    this.brushManager = on ? brushMgr : null;
    this._brushDrawing = false;
    this._brushLastPos = null;
    // 笔刷模式切出时，若正在绘制则取消
    if (!on && this.state === State.DRAWING && this.currentLineId) {
      this.lineManager.removeLineById(this.currentLineId);
      this.currentLineId = null;
      this.transitionTo(State.IDLE);
    }
  }

  /** 锁定到指定平面绘制 */
  setLockedPlane(plane) {
    this.lockedPlane = plane ? plane.clone() : null;
    this.planeLocked = true;
  }

  /** 解除平面锁定，恢复自由（垂直于视线）绘制 */
  clearLockedPlane() {
    this.planeLocked = false;
    this.lockedPlane = null;
  }

  /** 设置自由绘制时的投影面模式：'camera' | 'horizontal' */
  setFreePlaneMode(mode) {
    this.freePlaneMode = mode;
  }

  /** 取消当前正在绘制的线（Esc 用）：丢弃未定稿线条，回到 IDLE */
  cancelCurrentDraw() {
    if (this.state === State.DRAWING && this.currentLineId) {
      this.lineManager.removeLineById(this.currentLineId);
    }
    this.currentLineId = null;
    this.straightTempPoint = null;
    this.snapTarget = null;
    this.lineManager.hideSnapIndicator();
    this.lineManager.clearSnapGrow();
    this.isMouseDown = false;
    this.hasDragged = false;
    this.transitionTo(State.IDLE);
  }

  /** 设置从指定 3D 坐标开始绘制（Z 轴吸附用） */
  setSnapStartPoint(v3) {
    this._snapStartPoint = v3 ? v3.clone() : null;
  }

  bindEvents() {
    this._boundDown = this.onPointerDown.bind(this);
    this._boundMove = this.onPointerMove.bind(this);
    this._boundUp = this.onPointerUp.bind(this);
    this.canvas.addEventListener('pointerdown', this._boundDown);
    this.canvas.addEventListener('pointermove', this._boundMove);
    this.canvas.addEventListener('pointerup', this._boundUp);
    window.addEventListener('pointerup', this._boundUp);
  }

  /** 设置绘制模式 */
  setMode(mode) { this.lineManager.currentDrawMode = mode; }

  updateMouse(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** 射线检测端点 mesh */
  raycastEndpoints() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = this.lineManager.getEndpointMeshes();
    if (meshes.length === 0) return null;
    const intersects = this.raycaster.intersectObjects(meshes, false);
    return intersects.length > 0 ? intersects[0].object : null;
  }

  /** 射线检测线条（用于悬浮变色） */
  _raycastLine() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const objs = this.lineManager.getLineObjects();
    if (!objs.length) return null;
    const hits = this.raycaster.intersectObjects(objs.map(o => o.object), false);
    return hits.length > 0 ? (hits[0].object.userData.lineId || null) : null;
  }

  /** 射线与投影平面求交 */
  intersectProjectionPlane(firstPoint) {
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // ★ 平面锁定：所有点投影到固定平面，保证绘制共面
    if (this.planeLocked && this.lockedPlane) {
      const pt = new THREE.Vector3();
      return this.raycaster.ray.intersectPlane(this.lockedPlane, pt) ? pt.clone() : null;
    }

    // ★ 水平面自由模式：投影到过起点的水平面 XZ（真实3D水平笔触）
    //   笔触始终在同一高度平面内，旋转相机后可在不同 y 高度叠层绘制，
    //   从而拼出真正的 3D 结构（而非永远正对相机的薄片）。
    if (this.freePlaneMode === 'horizontal') {
      // Plane.set(normal, constant)，constant = -normal·point
      this.projectionPlane.set(new THREE.Vector3(0, 1, 0), -firstPoint.y);
      const pt = new THREE.Vector3();
      return this.raycaster.ray.intersectPlane(this.projectionPlane, pt) ? pt.clone() : null;
    }

    // 默认：镜头面（正对相机的平面）
    const viewDir = new THREE.Vector3();
    this.camera.getWorldDirection(viewDir);
    this.projectionPlane.set(viewDir, -viewDir.dot(firstPoint));
    const pt = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.projectionPlane, pt) ? pt.clone() : null;
  }

  /**
   * 基于"屏幕空间"查找最近的可吸附圆球。
   *
   * 做法：把每个圆球的世界坐标投影到屏幕像素坐标，计算鼠标（同样投影到
   * 像素）到球心的像素距离，与"该球的投影半径 + 容差(10px)"比较。
   * 这样判定与肉眼看到的"鼠标是否进入圆球"完全一致，无论相机远近、圆球
   * 在屏幕深浅方向如何，都不会失效。命中后返回球心精确坐标，定稿时
   * LineManager._findNearbyEndpoint 因坐标完全一致而复用原球，不再新建圆球。
   *
   * @returns {{key:string, position:THREE.Vector3, mesh:THREE.Mesh}|null}
   */
  _raySnapCandidate() {
    if (this.planeLocked) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const meshes = this.lineManager.getEndpointMeshes();
    const center = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(up.dot(camDir)) > 0.99) up.set(1, 0, 0);
    const tangent = new THREE.Vector3().crossVectors(camDir, up).normalize();

    let best = null;
    let bestPx = Infinity;
    for (const m of meshes) {
      if (!m.visible) continue;
      center.copy(m.position).project(this.camera);
      if (center.z > 1) continue; // 在相机背后 / 被裁剪
      const sx = (center.x * 0.5 + 0.5) * rect.width;
      const sy = (-center.y * 0.5 + 0.5) * rect.height;
      const mx = (this.mouse.x * 0.5 + 0.5) * rect.width;
      const my = (-this.mouse.y * 0.5 + 0.5) * rect.height;
      const distPx = Math.hypot(sx - mx, sy - my);

      // 计算该球在屏幕上的投影半径（像素）
      const r = (m.geometry && m.geometry.parameters && m.geometry.parameters.radius) || 0.15;
      edge.copy(m.position).addScaledVector(tangent, r).project(this.camera);
      const ex = (edge.x * 0.5 + 0.5) * rect.width;
      const ey = (-edge.y * 0.5 + 0.5) * rect.height;
      const radiusPx = Math.max(4, Math.hypot(ex - sx, ey - sy));
      const threshold = radiusPx + 10; // 容差 10 像素

      if (distPx < threshold && distPx < bestPx) {
        bestPx = distPx;
        best = m;
      }
    }
    if (best) {
      const key = this.lineManager.getEndpointKeyByMesh(best);
      return { key, position: best.position.clone(), mesh: best };
    }
    return null;
  }

  // ========== mousedown ==========
  onPointerDown(event) {
    if (event.button !== 0) return;
    this.updateMouse(event);

    // ★ 预览模式：禁用所有绘制交互
    if (!this.enabled) return;

    // ★ 笔刷模式：在锁定平面上绘制墨迹
    if (this.brushMode && this.brushManager) {
      // 平面已锁定时开始笔刷绘制（多边形顶点圆点 = 普通端点，不再切换/锁定平面）
      if (this.planeLocked) {
        const pt = this.intersectProjectionPlane(this.mouse);
        if (pt) {
          this._brushDrawing = true;
          this._brushLastPos = pt;
          this.brushManager.spawnBurst(pt, this.lineManager.currentColor);
        }
      }
      return;
    }

    // ★ Ctrl + 左键：多选/取消多选圆球
    if (event.ctrlKey && this.onMultiSelect) {
      const hitMesh = this.raycastEndpoints();
      if (hitMesh) {
        const key = this.lineManager.getEndpointKeyByMesh(hitMesh);
        this.onMultiSelect(key, hitMesh);
      } else {
        // Ctrl + 点击空白 → 清除所有多选
        this.onMultiSelect(null, null);
      }
      return; // 不进入绘制流程
    }

    this.isMouseDown = true;
    this.mouseDownPos.set(event.clientX, event.clientY);
    this.hasDragged = false;
    this.snapTarget = null;
    this._snapStartKey = null;
    this._snapEndKey = null;

    // ★ 点击 Z 轴 → 从 Z 轴上的交点开始绘制
    if (this._snapStartPoint) {
      this.transitionTo(State.DRAWING);
      const firstPoint = this._snapStartPoint.clone();
      this._snapStartPoint = null;
      const lineData = this.lineManager.createLine([firstPoint]);
      this.currentLineId = lineData.id;
      this.hasDragged = true;
      return;
    }

    const hitMesh = this.raycastEndpoints();

    if (hitMesh) {
      // 点击端点 → PENDING 续画（多边形顶点圆点 = 普通端点，不锁定平面、不转视角）
      this.transitionTo(State.PENDING);
      const endpointKey = this.lineManager.getEndpointKeyByMesh(hitMesh);
      this.pendingEndpointKey = endpointKey;
      this.pendingEndpointPosition = this.lineManager.getEndpointPosition(endpointKey);
      this.lineManager.highlightEndpoint(hitMesh);
      return;
    }

    // 空白区域：点中已有线条 → 选中该线条（不开始绘制），便于单条删除
    if (this.state === State.IDLE && !this.planeLocked && this.linePicker) {
      const pickId = this.linePicker(this.mouse, this.camera);
      if (pickId) {
        if (this.onLinePicked) this.onLinePicked(pickId);
        return;
      }
    }

    if (this.state === State.IDLE) {
      // 点击空白 → 开始绘制（先清除可能已有的线条选中 / 端点高亮）
      if (this.onLinePicked) this.onLinePicked(null);
      this.lineManager.unhighlightEndpoint();

      this.transitionTo(State.DRAWING);

      const cameraPos = this.camera.position.clone();
      const viewDir = new THREE.Vector3();
      this.camera.getWorldDirection(viewDir);
      const planeCenter = cameraPos.clone().add(viewDir.clone().multiplyScalar(5));
      let firstPoint = this.intersectProjectionPlane(planeCenter);
      if (!firstPoint) return;

      // ★ 起点若落在某个圆球内（鼠标进入圆球的屏幕空间判定），
      //    则以该圆球的精确空间坐标为起点，并放大该球反馈
      if (!this.planeLocked) {
        const startSnap = this._raySnapCandidate();
        if (startSnap) {
          firstPoint = startSnap.position.clone();
          this.snapTarget = startSnap;
          this._snapStartKey = startSnap.key;  // ★ 记录起点 key，避免 finalize 重复建球
          this.lineManager.showSnapIndicator(startSnap.position, this.lineManager.currentColor);
          this.lineManager.setSnapGrow(startSnap.mesh);
        }
      }

      const lineData = this.lineManager.createLine([firstPoint]);
      this.currentLineId = lineData.id;
      this.hasDragged = true;
    }
  }

  // ========== pointermove ==========
  onPointerMove(event) {
    this.updateMouse(event);

    if (this.isMouseDown) {
      const dx = event.clientX - this.mouseDownPos.x;
      const dy = event.clientY - this.mouseDownPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > this.dragThreshold) {
        this.hasDragged = true;
      }
    }

    // 始终更新相机引用（用于 snap indicator lookAt）
    this.scene.camera = this.camera;

    // ★ 笔刷模式：拖拽时生成墨迹粒子
    if (this._brushDrawing && this.brushManager && this.planeLocked) {
      const pt = this.intersectProjectionPlane(this.mouse);
      if (pt) {
        this.brushManager.spawnBurst(pt, this.lineManager.currentColor, 1);
        this._brushLastPos = pt;
      }
      return;
    }

    switch (this.state) {
      // ---- IDLE: hover 端点 / 悬浮线条 ----
      case State.IDLE: {
        const hitMesh = this.raycastEndpoints();
        if (hitMesh) {
          // 端点命中：清除线条悬浮
          this.lineManager.clearLineHover();
          this._hoveredLineId = null;
          this.transitionTo(State.HOVERING);
          this.lineManager.highlightEndpoint(hitMesh);
        } else {
          // 无端点命中 → 检测线条悬浮
          const hitLineId = this._raycastLine();
          if (hitLineId) {
            if (this._hoveredLineId !== hitLineId) {
              this.lineManager.setLineHover(hitLineId);
              this._hoveredLineId = hitLineId;
            }
          } else if (this._hoveredLineId) {
            this.lineManager.clearLineHover();
            this._hoveredLineId = null;
          }
        }
        break;
      }

      // ---- HOVERING: 保持高亮 ----
      case State.HOVERING: {
        const hitMesh = this.raycastEndpoints();
        if (hitMesh) {
          this.lineManager.highlightEndpoint(hitMesh);
        } else {
          this.lineManager.unhighlightEndpoint();
          this.transitionTo(State.IDLE);
        }
        break;
      }

      // ---- PENDING: 等待拖拽 ----
      case State.PENDING: {
        if (this.hasDragged) {
          this.transitionTo(State.DRAWING);
          const exactStartPos = this.pendingEndpointPosition.clone();
          const lineData = this.lineManager.createLine([exactStartPos]);
          this.currentLineId = lineData.id;
          this._snapStartKey = this.pendingEndpointKey;  // ★ 记录起点 key
          this.pendingEndpointPosition = null;
          this.pendingEndpointKey = null;

          // ★ 所有模式都立即补第一个绘制点，确保线条从这一帧就开始可见
          const firstDrawPt = this.intersectProjectionPlane(exactStartPos);
          if (firstDrawPt) {
            this.lineManager.appendPoint(this.currentLineId, firstDrawPt);
            if (this.lineManager.currentDrawMode === DrawMode.STRAIGHT) {
              this.straightTempPoint = firstDrawPt;
            }
          }
        }
        break;
      }

      // ---- DRAWING ----
      case State.DRAWING: {
        if (!this.currentLineId || !this.isMouseDown) break;

        const lineData = this.lineManager.lines.get(this.currentLineId);
        if (!lineData || lineData.points.length === 0) break;

        const firstPoint = lineData.points[0];

        // ★ 绘制过程中不再做实时吸附——只有按下/松开鼠标时才会把端点
        //    设在圆球代表的精确坐标上。经过圆球不做吸附。
        this.lineManager.hideSnapIndicator();
        this.lineManager.clearSnapGrow();

        if (this.lineManager.currentDrawMode === DrawMode.STRAIGHT) {
          // 直线模式：仅更新终点实时预览
          const pt = this.intersectProjectionPlane(firstPoint);
          if (!pt) break;

          // ★ 首次只有起点一个点时先追加，之后替换最后一点的实时位置
          if (lineData.points.length < 2) {
            this.lineManager.appendPoint(this.currentLineId, pt);
          } else {
            this.lineManager.replaceLastPoint(this.currentLineId, pt);
          }
          this.straightTempPoint = pt;
        } else {
          // 随手画 / 曲线模式：追加点
          const newPoint = this.intersectProjectionPlane(firstPoint);
          if (newPoint) {
            this.lineManager.appendPoint(this.currentLineId, newPoint);
          }
        }

        // 实时长度读数
        if (this.onMeasure) {
          const len = this.lineManager.getLineLength(this.currentLineId);
          this.onMeasure({ kind: 'drawing', length: len });
        }
        break;
      }
    }
  }

  // ========== pointerup ==========
  onPointerUp(event) {
    if (event.button !== 0) return;
    this.isMouseDown = false;
    this.updateMouse(event);

    // ★ 笔刷模式：停止笔刷绘制
    if (this._brushDrawing) {
      this._brushDrawing = false;
      this._brushLastPos = null;
      return;
    }

    switch (this.state) {
      case State.PENDING: {
        if (!this.hasDragged) {
          // 仅点击无拖拽 → 取消
          this.lineManager.unhighlightEndpoint();
          this.pendingEndpointPosition = null;
          this.pendingEndpointKey = null;
          this.transitionTo(State.IDLE);
        }
        break;
      }

      case State.DRAWING: {
        if (this.currentLineId) {
          // 先收起"进入圆球"的放大反馈
          this.lineManager.clearSnapGrow();
          const lineData = this.lineManager.lines.get(this.currentLineId);

          // 释放时最终吸附兜底：以防最后一次 pointermove 与 pointerup 合并而漏吸附
          if (lineData && lineData.points.length >= 2 && !this.planeLocked) {
            const finalSnap = this._raySnapCandidate();
            if (finalSnap) {
              this.snapTarget = finalSnap;
              this._snapEndKey = finalSnap.key;  // ★ 兜底更新终点 key
              this.lineManager.replaceLastPoint(this.currentLineId, finalSnap.position);
            }
          }

          // 若该端落在圆球上，则这端坐标精确等于圆球坐标
          if (this.snapTarget) {
            this.lineManager.replaceLastPoint(this.currentLineId, this.snapTarget.position);
          }

          this.lineManager.hideSnapIndicator();
          this.snapTarget = null;

          if (lineData && lineData.points.length >= 2) {
            // ★ 定稿前先回调，供 main 记录撤销快照
            if (this.onLineFinalized) this.onLineFinalized(lineData, this.lineManager.currentDrawMode);
            // ★ 传入已知吸附 key，直接复用已有端点，不再新建圆球
            this.lineManager.finalizeLineWithSnap(
              this.currentLineId,
              this._snapStartKey,
              this._snapEndKey
            );
          } else {
            this.lineManager.removeLineById(this.currentLineId);
          }
        }
        // 绘制结束：清除
        if (this.onMeasure) this.onMeasure(null);
        this.currentLineId = null;
        this.straightTempPoint = null;
        this._snapStartKey = null;
        this._snapEndKey = null;
        this.hasDragged = false;

        // 检查当前是否在端点上
        const hitMesh = this.raycastEndpoints();
        if (hitMesh) {
          this.lineManager.highlightEndpoint(hitMesh);
          this.transitionTo(State.HOVERING);
        } else {
          this.transitionTo(State.IDLE);
        }
        break;
      }

      default:
        break;
    }
  }

  transitionTo(newState) {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    // 离开 IDLE 时清除线条悬浮
    if (oldState === State.IDLE) {
      this.lineManager.clearLineHover();
      this._hoveredLineId = null;
    }
    if (this.onStateChange) this.onStateChange(newState, oldState);
  }

  isDrawing() { return this.state === State.DRAWING; }

  dispose() {}
}