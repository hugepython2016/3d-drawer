import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

/**
 * LineManager - 数据层：管理所有线条和端点的纯数据
 *
 * 核心设计：
 * - 端点坐标存储在 endpointRegistry(Map) 中
 * - 端点 mesh 的 userData.endpointKey 指向该 key
 * - 精确坐标始终从 endpointRegistry 读取
 * - 支持薄线(THREE.Line) 和 厚线(Line2)
 * - 支持随手画 / 直线 / 曲线三种模式
 */

// 预设颜色
export const COLOR_PALETTE = [
  0x6366f1, 0x22d3ee, 0x10b981, 0xf59e0b, 0xec4899,
  0xf97316, 0x8b5cf6, 0x06b6d4, 0xef4444, 0x84cc16,
];

// 粗细预设 (像素单位，仅 medium/thick 使用 Line2)
const WIDTH_PRESETS = {
  thin: { label: '细', value: 1, useLine2: false },
  medium: { label: '中', value: 2, useLine2: true, pixelWidth: 5 },
  thick: { label: '粗', value: 3, useLine2: true, pixelWidth: 10 },
};

// 绘制模式
export const DrawMode = {
  FREEHAND: 'freehand',
  STRAIGHT: 'straight',
  CURVE: 'curve',
};

// 交互状态
export const State = {
  IDLE: 'IDLE',
  HOVERING: 'HOVERING',
  PENDING: 'PENDING',
  DRAWING: 'DRAWING',
};

export class LineManager {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this._resolution = new THREE.Vector2();

    /** 当前选中的颜色 */
    this.currentColor = COLOR_PALETTE[0];

    /** 当前粗细预设 key: 'thin' | 'medium' | 'thick'（序列化兼容用） */
    this.currentWidthKey = 'thin';

    /** 当前线条像素宽度（滑块控制，1-20） */
    this.currentPixelWidth = 3;

    /** 当前绘制模式 */
    this.currentDrawMode = DrawMode.FREEHAND;

    /** @type {Map<string, {id, points: THREE.Vector3[], color: number, lineObject, useLine2: boolean}>} */
    this.lines = new Map();

    /** 端点注册表 */
    this.endpointRegistry = new Map();
    this.endpointMeshes = [];
    this.highlightedEndpoint = null;
    this.highlightOriginalScale = 1.0;

    /** 绘制中的吸附提示球 */
    this.snapIndicator = null;

    /** 当前因吸附而放大的圆球（绘制时"进入圆球"的视觉反馈） */
    this._snapGrowMesh = null;

    /** 当前鼠标悬浮的线条 id */
    this._hoveredLineId = null;

    // 初始化端点颜色（使用当前颜色）
    this._colorIndex = 0;
  }

  /** 获取当前颜色并推进轮转 */
  nextColor() {
    const c = this.currentColor;
    this._colorIndex++;
    return c;
  }

  /** 设置颜色 */
  setColor(hex) {
    this.currentColor = hex;
  }

  /** 设置粗细预设 key（兼容旧三档按钮/序列化） */
  setWidthKey(key) {
    if (WIDTH_PRESETS[key]) {
      this.currentWidthKey = key;
      if (WIDTH_PRESETS[key].pixelWidth) this.currentPixelWidth = WIDTH_PRESETS[key].pixelWidth;
    }
  }

  /** 设置线条像素宽度（滑块用，1-20）。同步更新 widthKey 以兼容序列化 */
  setLineWidth(px) {
    this.currentPixelWidth = Math.max(1, Math.min(20, px));
    // 同步一个近似的 widthKey（序列化/撤销快照兼容）
    if (this.currentPixelWidth <= 1) this.currentWidthKey = 'thin';
    else if (this.currentPixelWidth <= 5) this.currentWidthKey = 'medium';
    else this.currentWidthKey = 'thick';
  }

  /** 获取当前粗细预设 */
  getWidthPreset() {
    return WIDTH_PRESETS[this.currentWidthKey];
  }

  /** 设置绘制模式 */
  setDrawMode(mode) {
    this.currentDrawMode = mode;
  }

  /**
   * 创建一条新线条。如果只有 1 个点，不会立即创建渲染对象，
   * 而是暂存点数据，等 appendPoint 补足 2 个点后再创建。
   * @param {THREE.Vector3[]} points
   * @returns {object|null}
   */
  createLine(points, color = null) {
    const lineId = `line_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lineColor = color ?? this.currentColor;
    const px = this.currentPixelWidth;
    const useLine2 = px > 1;   // 1px 用原生 Line，>1px 用 Line2

    if (points.length < 2) {
      // ★ 延迟创建：先只存数据，等积累到 2 点再建渲染对象
      const lineData = {
        id: lineId,
        points: points.map(p => p.clone()),
        color: lineColor,
        lineObject: null,       // 尚未创建
        useLine2,
        _pendingPixelWidth: px,
        mode: this.currentDrawMode,
        widthKey: this.currentWidthKey,
      };
      this.lines.set(lineId, lineData);
      return lineData;
    }

    if (useLine2) {
      return this._createLine2(lineId, points, lineColor, px);
    }
    return this._createLine1(lineId, points, lineColor);
  }

  /** 薄线（Three.Line） */
  _createLine1(lineId, points, color) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = points[i].z;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setDrawRange(0, points.length);

    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,   // ★ 不写深度，避免线间闪烁
    });

    const lineObject = new THREE.Line(geometry, material);
    lineObject.renderOrder = 1;  // ★ 渲染顺序，避免被其他物遮挡

    const existing = this.lines.get(lineId);
    if (existing) {
      // 惰性创建后覆盖场景对象引用
      existing.lineObject = lineObject;
      existing.useLine2 = false;
      existing.mode = this.currentDrawMode;
      existing.widthKey = this.currentWidthKey;
      lineObject.userData.lineId = lineId;
      this.scene.add(lineObject);
      return existing;
    }

    this.scene.add(lineObject);
    lineObject.userData.lineId = lineId;
    const lineData = {
      id: lineId, points: [...points], color, lineObject, useLine2: false,
      mode: this.currentDrawMode, widthKey: this.currentWidthKey, pixelWidth: 1,
    };
    this.lines.set(lineId, lineData);
    return lineData;
  }

  /** 厚线（Line2） */
  _createLine2(lineId, points, color, pixelWidth) {
    const positions = [];
    for (const p of points) {
      positions.push(p.x, p.y, p.z);
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    // 同步当前 canvas 像素分辨率
    this.renderer.getSize(this._resolution);

    const material = new LineMaterial({
      color,
      linewidth: pixelWidth,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,      // ★ 不写深度，避免线间闪烁
      resolution: this._resolution.clone(),
      dashed: false,
    });

    const lineObject = new Line2(geometry, material);
    lineObject.computeLineDistances();
    lineObject.renderOrder = 1;  // ★ 渲染顺序

    // 惰性创建：已有 lineData（由 createLine 预存），补充 lineObject
    const existing = this.lines.get(lineId);
    if (existing) {
      existing.lineObject = lineObject;
      existing.useLine2 = true;
      existing.mode = this.currentDrawMode;
      existing.widthKey = this.currentWidthKey;
      lineObject.userData.lineId = lineId;
      this.scene.add(lineObject);
      return existing;
    }

    this.scene.add(lineObject);
    lineObject.userData.lineId = lineId;
    const lineData = {
      id: lineId, points: [...points], color, lineObject, useLine2: true,
      mode: this.currentDrawMode, widthKey: this.currentWidthKey, pixelWidth,
    };
    this.lines.set(lineId, lineData);
    return lineData;
  }

  /**
   * 向已有线条追加点。若线条对象尚未创建（只有 1 个点的惰性状态），
   * 现在凑够 2 个点后立即创建渲染对象。
   */
  appendPoint(lineId, point) {
    const lineData = this.lines.get(lineId);
    if (!lineData) return;

    lineData.points.push(point.clone());

    // ★ 惰性创建：之前只有 1 个点，lineObject 为空，现在可以建了
    if (!lineData.lineObject) {
      if (lineData.points.length >= 2) {
        if (lineData.useLine2) {
          this._createLine2(lineData.id, lineData.points, lineData.color, lineData._pendingPixelWidth);
        } else {
          this._createLine1(lineData.id, lineData.points, lineData.color);
        }
      }
      return;
    }

    this._rebuildLineGeometry(lineData);
  }

  /** 替换最后一个点（用于端点吸附） */
  replaceLastPoint(lineId, point) {
    const lineData = this.lines.get(lineId);
    if (!lineData || lineData.points.length === 0) return;

    lineData.points[lineData.points.length - 1] = point.clone();
    this._rebuildLineGeometry(lineData);
  }

  /** 重建线条几何体 */
  _rebuildLineGeometry(lineData) {
    if (!lineData.lineObject) return;  // 惰性创建前跳过

    if (lineData.useLine2) {
      const positions = [];
      for (const p of lineData.points) {
        positions.push(p.x, p.y, p.z);
      }

      // ★ 重建 LineGeometry，避免 setPositions 多次更新出现退化段
      lineData.lineObject.geometry.dispose();
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      lineData.lineObject.geometry = geometry;

      // ★ 确保分辨率同步
      this.renderer.getSize(this._resolution);
      if (lineData.lineObject.material.resolution) {
        lineData.lineObject.material.resolution.copy(this._resolution);
      }
      lineData.lineObject.computeLineDistances();
      lineData.lineObject.material.needsUpdate = true;
    } else {
      const geometry = lineData.lineObject.geometry;
      const positions = new Float32Array(lineData.points.length * 3);
      for (let i = 0; i < lineData.points.length; i++) {
        positions[i * 3] = lineData.points[i].x;
        positions[i * 3 + 1] = lineData.points[i].y;
        positions[i * 3 + 2] = lineData.points[i].z;
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setDrawRange(0, lineData.points.length);
      geometry.attributes.position.needsUpdate = true;
    }
  }

  /**
   * 对线条点集做 CatmullRom 平滑（曲线模式用）
   */
  _smoothPoints(points) {
    if (points.length < 2) return points;

    if (points.length === 2) {
      // 两点之间插值生成曲线
      const curve = new THREE.QuadraticBezierCurve3(
        points[0].clone(),
        points[0].clone().add(points[1]).multiplyScalar(0.5).add(
          new THREE.Vector3(0, (points[1].y - points[0].y) * 0.3 + 0.3, 0)
        ),
        points[1].clone()
      );
      const sampled = curve.getPoints(Math.max(20, Math.floor(curve.getLength() * 10)));
      return sampled;
    }

    // 多点用 CatmullRom
    const curve = new THREE.CatmullRomCurve3(points);
    const sampled = curve.getPoints(points.length * 10);
    return sampled;
  }

  /**
   * 完成线条：创建端点球体
   */
  finalizeLine(lineId) {
    const lineData = this.lines.get(lineId);
    if (!lineData) return null;

    // 没有渲染对象说明点不够（少于 2 点），直接清理
    if (!lineData.lineObject || lineData.points.length < 2) {
      this.lines.delete(lineId);
      return null;
    }

    // 曲线模式：平滑后再建端点
    if (this.currentDrawMode === DrawMode.CURVE) {
      const smoothed = this._smoothPoints(lineData.points);
      lineData.points = smoothed;
      this._rebuildLineGeometry(lineData);
    }

    // 直线模式：只保留首尾两点
    if (this.currentDrawMode === DrawMode.STRAIGHT) {
      lineData.points = [lineData.points[0].clone(), lineData.points[lineData.points.length - 1].clone()];
      this._rebuildLineGeometry(lineData);
    }

    const startPoint = lineData.points[0].clone();
    const endPoint = lineData.points[lineData.points.length - 1].clone();

    // 检查端点是否与已有端点重合（阈值 0.3），重合则共享
    let startKey = this._findNearbyEndpoint(startPoint);
    let endKey = this._findNearbyEndpoint(endPoint);

    if (!startKey) {
      startKey = `${lineId}_start`;
      const startMesh = this._createEndpointMesh(startPoint, lineData.color);
      startMesh.userData.endpointKey = startKey;
      this.endpointRegistry.set(startKey, { position: startPoint, lineId, isStart: true });
      this.endpointMeshes.push(startMesh);
    } else if (!this.endpointRegistry.get(startKey)?.isAnchor) {
      // 共享已有端点的非锚点（即另一条线的端点）：用新线颜色覆盖，视觉统一
      this._updateEndpointColor(startKey, lineData.color);
    }
    // 若是锚点（多边形顶点 / 双击生成的独立圆球），保留其原色，避免"球变了身份"

    if (!endKey) {
      endKey = `${lineId}_end`;
      const endMesh = this._createEndpointMesh(endPoint, lineData.color);
      endMesh.userData.endpointKey = endKey;
      this.endpointRegistry.set(endKey, { position: endPoint, lineId, isStart: false });
      this.endpointMeshes.push(endMesh);
    } else if (!this.endpointRegistry.get(endKey)?.isAnchor) {
      this._updateEndpointColor(endKey, lineData.color);
    }

    return { startKey, endKey };
  }

  /**
   * 定稿线条，允许指定起点/终点复用的已知端点 key。
   * 若提供 snapStartKey / snapEndKey，则跳过位置查找直接复用。
   */
  finalizeLineWithSnap(lineId, snapStartKey = null, snapEndKey = null) {
    const lineData = this.lines.get(lineId);
    if (!lineData) return null;

    if (!lineData.lineObject || lineData.points.length < 2) {
      this.lines.delete(lineId);
      return null;
    }

    // 曲线 / 直线模式处理
    if (this.currentDrawMode === DrawMode.CURVE) {
      const smoothed = this._smoothPoints(lineData.points);
      lineData.points = smoothed;
      this._rebuildLineGeometry(lineData);
    }
    if (this.currentDrawMode === DrawMode.STRAIGHT) {
      lineData.points = [lineData.points[0].clone(), lineData.points[lineData.points.length - 1].clone()];
      this._rebuildLineGeometry(lineData);
    }

    const startPoint = lineData.points[0].clone();
    const endPoint = lineData.points[lineData.points.length - 1].clone();

    // ★ 起点：优先用传入的 snapStartKey，其次位置匹配
    let startKey = snapStartKey || this._findNearbyEndpoint(startPoint);
    // ★ 终点：优先用传入的 snapEndKey，其次位置匹配
    let endKey = snapEndKey || this._findNearbyEndpoint(endPoint);

    if (!startKey) {
      startKey = `${lineId}_start`;
      const startMesh = this._createEndpointMesh(startPoint, lineData.color);
      startMesh.userData.endpointKey = startKey;
      this.endpointRegistry.set(startKey, { position: startPoint, lineId, isStart: true });
      this.endpointMeshes.push(startMesh);
    } else if (!this.endpointRegistry.get(startKey)?.isAnchor) {
      this._updateEndpointColor(startKey, lineData.color);
    }

    if (!endKey) {
      endKey = `${lineId}_end`;
      const endMesh = this._createEndpointMesh(endPoint, lineData.color);
      endMesh.userData.endpointKey = endKey;
      this.endpointRegistry.set(endKey, { position: endPoint, lineId, isStart: false });
      this.endpointMeshes.push(endMesh);
    } else if (!this.endpointRegistry.get(endKey)?.isAnchor) {
      this._updateEndpointColor(endKey, lineData.color);
    }

    // ★ 记录线条端点 key，供 moveEndpoint 查找受影响的线条
    lineData.startKey = startKey;
    lineData.endKey = endKey;

    return { startKey, endKey };
  }

  /**
   * 移动端点（圆点/圆球/线条端点）到新位置，同步更新所有引用该端点的线条几何。
   * @param {string} key 端点 key
   * @param {THREE.Vector3} newPos 新位置
   */
  moveEndpoint(key, newPos) {
    const data = this.endpointRegistry.get(key);
    if (!data) return;
    // 1) 更新注册表位置
    data.position.copy(newPos);
    // 2) 更新 mesh 位置
    const mesh = this.endpointMeshes.find(m => m.userData.endpointKey === key);
    if (mesh) mesh.position.copy(newPos);
    // 3) 更新所有引用该 key 的线条端点 + 重建几何
    for (const [, ld] of this.lines) {
      if (!ld.lineObject) continue;
      let changed = false;
      if (ld.startKey === key) {
        ld.points[0].copy(newPos);
        changed = true;
      }
      if (ld.endKey === key) {
        ld.points[ld.points.length - 1].copy(newPos);
        changed = true;
      }
      if (changed) this._rebuildLineGeometry(ld);
    }
  }

  /**
   * 在绘制过程中，检查最后一点是否接近某个端点，返回端点 key 或 null
   * @param {THREE.Vector3} lastPoint
   * @param {number} [snapDist=0.4] 吸附距离阈值（可由相机距离自适应放大）
   */
  checkSnapToEndpoint(lastPoint, snapDist = 0.4) {
    for (const [key, data] of this.endpointRegistry) {
      if (lastPoint.distanceTo(data.position) < snapDist) {
        return { key, position: data.position.clone() };
      }
    }
    return null;
  }

  /**
   * 查找与给定位置接近（< 0.3）的已有端点，返回 key 或 null
   * 阈值与 _raySnapCandidate 屏幕空间判定对齐
   */
  _findNearbyEndpoint(pos) {
    // ★ 优先精确匹配（距离 < 0.005），基本等于重合
    for (const [key, data] of this.endpointRegistry) {
      if (pos.distanceTo(data.position) < 0.005) return key;
    }
    // ★ 宽松匹配（距离 < 0.3），与吸附半径一致
    for (const [key, data] of this.endpointRegistry) {
      if (pos.distanceTo(data.position) < 0.3) return key;
    }
    return null;
  }

  /** 更新端点小球颜色 */
  _updateEndpointColor(endpointKey, color) {
    const idx = this.endpointMeshes.findIndex(m => m.userData.endpointKey === endpointKey);
    if (idx !== -1) {
      this.endpointMeshes[idx].material.color.set(color);
    }
  }

  /** 获取端点精确坐标 */
  getEndpointPosition(endpointKey) {
    const data = this.endpointRegistry.get(endpointKey);
    return data ? data.position.clone() : null;
  }

  /** 通过 mesh 获取 key */
  getEndpointKeyByMesh(mesh) {
    return mesh.userData?.endpointKey || null;
  }

  /** 创建端点球体 */
  _createEndpointMesh(position, color) {
    const geometry = new THREE.SphereGeometry(0.15, 32, 32);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: true,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.position.copy(position);
    sphere.renderOrder = 1;
    sphere.userData._baseScale = 1;
    this.scene.add(sphere);
    return sphere;
  }

  /** 高亮端点 */
  highlightEndpoint(mesh) {
    if (this.highlightedEndpoint === mesh) return;
    this.unhighlightEndpoint();
    this.highlightedEndpoint = mesh;
    this.highlightOriginalScale = mesh.scale.x;
    mesh.scale.setScalar(1.4);
    mesh.material.opacity = 0.9;
  }

  /** 取消高亮 */
  unhighlightEndpoint() {
    if (!this.highlightedEndpoint) return;
    this.highlightedEndpoint.scale.setScalar(this.highlightOriginalScale);
    this.highlightedEndpoint.material.opacity = 0.6;
    this.highlightedEndpoint = null;
  }

  /**
   * 让某个圆球"放大"，作为"鼠标已进入该球、线条端头已锁定到球心"的视觉反馈。
   * 同时只放大一个，切换时自动还原上一个。
   * @param {THREE.Mesh|null} mesh
   */
  setSnapGrow(mesh) {
    if (!mesh) return;
    if (this._snapGrowMesh === mesh) return;
    this.clearSnapGrow();
    // 若当前正处于 hover 高亮状态，先还原，避免缩放冲突
    if (this.highlightedEndpoint === mesh) {
      this.unhighlightEndpoint();
    }
    this._snapGrowMesh = mesh;
    // ★ 放大到 2.5x + 提高不透明度，视觉反馈更明显
    mesh.scale.setScalar((mesh.userData._baseScale ?? 1) * 2.5);
    mesh.material.opacity = 0.95;
    // ★ 暂存原色并置为亮白高亮，明确"已锁定"
    mesh.userData._snapOrigColor = mesh.material.color.getHex();
    mesh.material.color.set(0xffffff);
  }

  /** 还原被放大的圆球 */
  clearSnapGrow() {
    if (!this._snapGrowMesh) return;
    const m = this._snapGrowMesh;
    m.scale.setScalar(m.userData._baseScale ?? 1);
    // ★ 还原颜色
    if (m.userData._snapOrigColor !== undefined) {
      m.material.color.set(m.userData._snapOrigColor);
      delete m.userData._snapOrigColor;
    }
    this._snapGrowMesh = null;
  }

  /** 显示/更新吸附指示器 */
  showSnapIndicator(position, color) {
    if (!this.snapIndicator) {
      const geom = new THREE.RingGeometry(0.18, 0.22, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
        depthWrite: false,
      });
      this.snapIndicator = new THREE.Mesh(geom, mat);
      this.snapIndicator.renderOrder = 2;
      this.scene.add(this.snapIndicator);
    }
    this.snapIndicator.position.copy(position);
    this.snapIndicator.visible = true;
    // 让环朝向相机
    this.snapIndicator.lookAt(this.scene.camera?.position || position);
  }

  hideSnapIndicator() {
    if (this.snapIndicator) {
      this.snapIndicator.visible = false;
    }
  }

  /**
   * 添加独立锚点（多边形顶点等），自动注册到端点系统可被吸附
   * @param {THREE.Vector3} position
   * @param {number} [color] - 可选颜色
   * @param {number} [radius] - 球体半径，默认 0.15
   * @returns {{ key: string, mesh: THREE.Mesh }}
   */
  addAnchorPoint(position, color, radius = 0.15) {
    const key = `anchor_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const c = color ?? this.currentColor;
    const geom = new THREE.SphereGeometry(radius, 32, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity: 0.75,
      depthTest: true,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(geom, mat);
    sphere.position.copy(position);
    sphere.userData.endpointKey = key;
    sphere.userData._isAnchor = true;
    sphere.userData._baseScale = 1;
    sphere.renderOrder = 1;
    this.scene.add(sphere);

    this.endpointRegistry.set(key, { position: position.clone(), lineId: null, isStart: false, isAnchor: true });
    this.endpointMeshes.push(sphere);

    return { key, mesh: sphere };
  }

  /**
   * 移除锚点
   * @param {string} key
   */
  removeAnchorPoint(key) {
    this.endpointRegistry.delete(key);
    const idx = this.endpointMeshes.findIndex(m => m.userData.endpointKey === key);
    if (idx !== -1) {
      const mesh = this.endpointMeshes[idx];
      if (this.highlightedEndpoint === mesh) this.unhighlightEndpoint();
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.endpointMeshes.splice(idx, 1);
    }
  }

  /**
   * 批量移除所有锚点（key 以 anchor_ 开头）
   */
  removeAllAnchors() {
    const anchorKeys = [];
    for (const [key, data] of this.endpointRegistry) {
      if (data.isAnchor) anchorKeys.push(key);
    }
    for (const key of anchorKeys) {
      this.removeAnchorPoint(key);
    }
  }

  getEndpointMeshes() {
    return this.endpointMeshes;
  }

  /**
   * 窗口大小变化时更新所有 LineMaterial 的 resolution
   */
  updateResolution() {
    if (!this.renderer) return;
    this.renderer.getSize(this._resolution);
    for (const [, lineData] of this.lines) {
      if (lineData.useLine2 && lineData.lineObject.material) {
        lineData.lineObject.material.resolution.copy(this._resolution);
      }
    }
  }

  /* ============================================================
   *  线条选中 / 删除 / 序列化 / 测量
   * ============================================================ */

  /** 获取所有已渲染线条对象（含 id），用于射线拾取 */
  getLineObjects() {
    const arr = [];
    for (const [id, data] of this.lines) {
      if (data.lineObject) arr.push({ id, object: data.lineObject });
    }
    return arr;
  }

  /** 获取线条数据 */
  getLineData(lineId) {
    return this.lines.get(lineId) || null;
  }

  /** 高亮某条线（暂存原色，切换为高亮色） */
  setLineHighlight(lineId) {
    const data = this.lines.get(lineId);
    if (!data || !data.lineObject) return;
    this.clearLineHighlight();
    this.clearLineHover();  // ★ 清除悬浮效果，避免颜色冲突
    const mat = data.lineObject.material;
    if (data._origColor === undefined) data._origColor = mat.color.getHex();
    mat.color.set(0xffcc00);
    mat.opacity = 1;
    this._highlightedLineId = lineId;
  }

  /** 取消线条高亮 */
  clearLineHighlight() {
    if (this._highlightedLineId === undefined || this._highlightedLineId === null) return;
    const data = this.lines.get(this._highlightedLineId);
    if (data && data.lineObject && data._origColor !== undefined) {
      data.lineObject.material.color.set(data._origColor);
    }
    this._highlightedLineId = null;
  }

  /** 鼠标悬浮线条：变色 + 变粗 */
  setLineHover(lineId) {
    if (this._hoveredLineId === lineId) return;
    this.clearLineHover();
    // 不悬浮当前已选中的线条
    if (this._highlightedLineId === lineId) return;

    const data = this.lines.get(lineId);
    if (!data || !data.lineObject) return;

    const mat = data.lineObject.material;
    data._hvOrigColor = mat.color.getHex();
    data._hvOrigOpacity = mat.opacity;
    if (data.useLine2 && mat.linewidth !== undefined) {
      data._hvOrigWidth = mat.linewidth;
    }
    // 应用悬浮效果
    mat.color.set(0x66ccff);
    mat.opacity = 1.0;
    if (data.useLine2 && mat.linewidth !== undefined) {
      mat.linewidth = Math.min(data._hvOrigWidth * 2, 20);
      mat.needsUpdate = true;
    }
    this._hoveredLineId = lineId;
  }

  /** 取消线条悬浮 */
  clearLineHover() {
    if (!this._hoveredLineId) return;
    const data = this.lines.get(this._hoveredLineId);
    if (data && data.lineObject) {
      const mat = data.lineObject.material;
      if (data._hvOrigColor !== undefined) mat.color.set(data._hvOrigColor);
      if (data._hvOrigOpacity !== undefined) mat.opacity = data._hvOrigOpacity;
      if (data.useLine2 && data._hvOrigWidth !== undefined && mat.linewidth !== undefined) {
        mat.linewidth = data._hvOrigWidth;
        mat.needsUpdate = true;
      }
    }
    this._hoveredLineId = null;
  }

  /** 设置/取消多选高亮 */
  setMultiSelectHighlight(mesh, on) {
    if (!mesh) return;
    if (on) {
      mesh.userData._msOrigColor = mesh.material.color.getHex();
      mesh.userData._msOrigScale = mesh.scale.x;
      mesh.userData._msOrigOpacity = mesh.material.opacity;
      mesh.scale.setScalar(1.7);
      mesh.material.color.set(0xff6600);
      mesh.material.opacity = 0.95;
    } else {
      if (mesh.userData._msOrigColor !== undefined) {
        mesh.material.color.set(mesh.userData._msOrigColor);
        delete mesh.userData._msOrigColor;
      }
      if (mesh.userData._msOrigScale !== undefined) {
        mesh.scale.setScalar(mesh.userData._msOrigScale);
        delete mesh.userData._msOrigScale;
      }
      if (mesh.userData._msOrigOpacity !== undefined) {
        mesh.material.opacity = mesh.userData._msOrigOpacity;
        delete mesh.userData._msOrigOpacity;
      }
    }
  }

  /** 清除所有多选高亮 */
  clearAllMultiSelectHighlights() {
    this.endpointMeshes.forEach(m => {
      if (m.userData._msOrigColor !== undefined) {
        this.setMultiSelectHighlight(m, false);
      }
    });
  }

  /** 删除指定线条及其专属端点（供单条删除 / 撤销重做使用） */
  deleteLine(lineId) {
    const data = this.lines.get(lineId);
    if (!data) return;
    this._removeLineObject(data);
    this._removeEndpointsForLine(lineId);
    this.lines.delete(lineId);
    if (this._highlightedLineId === lineId) this._highlightedLineId = null;
  }

  /**
   * 由快照重建一条线（撤销/重做/导入用）
   * @param {{controlPoints:number[][], color:number, widthKey:string, mode:string, finalized?:boolean}} snap
   * @returns {string} 新线条 id
   */
  recreateLine(snap) {
    const prev = { color: this.currentColor, width: this.currentWidthKey, px: this.currentPixelWidth, mode: this.currentDrawMode };
    this.currentColor = snap.color;
    this.currentWidthKey = snap.widthKey;
    this.currentPixelWidth = snap.pixelWidth || WIDTH_PRESETS[snap.widthKey]?.pixelWidth || 3;
    // finalized=true 表示点已为最终形态（如清空/导出时捕获），直接按随手画重建避免二次平滑
    this.currentDrawMode = snap.finalized ? DrawMode.FREEHAND : snap.mode;
    const pts = snap.controlPoints.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const ld = this.createLine(pts);
    this.finalizeLine(ld.id);
    this.currentColor = prev.color;
    this.currentWidthKey = prev.width;
    this.currentPixelWidth = prev.px;
    this.currentDrawMode = prev.mode;
    return ld.id;
  }

  /** 计算线条总长度（世界单位） */
  getLineLength(lineId) {
    const data = this.lines.get(lineId);
    if (!data || data.points.length < 2) return 0;
    let len = 0;
    for (let i = 1; i < data.points.length; i++) {
      len += data.points[i].distanceTo(data.points[i - 1]);
    }
    return len;
  }

  /** 端点坐标（用于角度等测量） */
  getLineEndpoints(lineId) {
    const data = this.lines.get(lineId);
    if (!data || data.points.length < 2) return null;
    return {
      start: data.points[0].clone(),
      end: data.points[data.points.length - 1].clone(),
    };
  }

  /** 预览模式下隐藏线条端点球（保留辅助多边形锚点） */
  setEndpointBallsVisible(on) {
    for (const m of this.endpointMeshes) {
      if (!m.userData._isAnchor) m.visible = on;
    }
  }

  /** 序列化当前所有线条为快照数组（导出 / 清空前快照用） */
  serializeLines() {
    const arr = [];
    for (const [, data] of this.lines) {
      if (!data.lineObject) continue;
      arr.push({
        controlPoints: data.points.map(p => [p.x, p.y, p.z]),
        color: data.color,
        widthKey: data.widthKey || 'thin',
        pixelWidth: data.pixelWidth || 3,
        mode: data.mode || DrawMode.FREEHAND,
        finalized: true,
      });
    }
    return arr;
  }

  undoLast() {
    const entries = [...this.lines.entries()];
    if (entries.length === 0) return false;

    const [lineId, lineData] = entries[entries.length - 1];
    this._removeEndpointsForLine(lineId);
    this._removeLineObject(lineData);
    this.lines.delete(lineId);
    this.unhighlightEndpoint();
    return true;
  }

  _removeEndpointsForLine(lineId) {
    const startKey = `${lineId}_start`;
    const endKey = `${lineId}_end`;
    this._removeEndpointByKey(startKey);
    this._removeEndpointByKey(endKey);
  }

  _removeEndpointByKey(key) {
    this.endpointRegistry.delete(key);
    const idx = this.endpointMeshes.findIndex(m => m.userData.endpointKey === key);
    if (idx !== -1) {
      const mesh = this.endpointMeshes[idx];
      if (this.highlightedEndpoint === mesh) this.unhighlightEndpoint();
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.endpointMeshes.splice(idx, 1);
    }
  }

  _removeLineObject(lineData) {
    if (!lineData.lineObject) return;  // 惰性状态，没有渲染对象
    this.scene.remove(lineData.lineObject);
    lineData.lineObject.geometry.dispose();
    lineData.lineObject.material.dispose();
  }

  removeLineById(lineId) {
    const lineData = this.lines.get(lineId);
    if (!lineData) return;
    this._removeLineObject(lineData);
    this.lines.delete(lineId);
  }

  clearAll() {
    this.unhighlightEndpoint();
    this.hideSnapIndicator();

    for (const [, lineData] of this.lines) {
      this._removeLineObject(lineData);
    }
    this.lines.clear();

    for (const mesh of this.endpointMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.endpointMeshes = [];
    this.endpointRegistry.clear();
  }

  /**
   * 仅清空绘制的线条及其专属端点，保留辅助多边形锚点
   */
  clearLinesOnly() {
    this.unhighlightEndpoint();
    this.hideSnapIndicator();

    for (const [, lineData] of this.lines) {
      this._removeLineObject(lineData);
    }
    this.lines.clear();

    const remaining = [];
    for (const mesh of this.endpointMeshes) {
      if (mesh.userData._isAnchor) {
        remaining.push(mesh);
      } else {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
    this.endpointMeshes = remaining;

    for (const [key, data] of [...this.endpointRegistry]) {
      if (!data.isAnchor) this.endpointRegistry.delete(key);
    }
  }
}