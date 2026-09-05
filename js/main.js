/* ================================================================
 *  main.js — 3D 画线工具主入口
 *  - 只有 Y 轴 hover 变粗变色
 *  - 右击 Y 轴 → 弹出输入框：半径 + 边数 → 生成辅助多边形
 *  - 辅助多边形：灰色虚线边框 + 灰色半透顶点球，仅编辑辅助
 * ================================================================ */
import { createScene } from './SceneSetup.js?v=26';
import { LineManager, DrawMode, COLOR_PALETTE } from './LineManager.js?v=26';
import { DrawingController } from './DrawingController.js?v=26';
import { BrushManager } from './BrushManager.js?v=26';
import * as THREE from 'three';

/* ================================================================
 *  DOM
 * ================================================================ */
const canvas3D    = document.getElementById('canvas3D');
const hintMsgEl   = document.getElementById('hint-message');
const hintCoordsEl = document.getElementById('hint-coords');

// 默认帮助提示文本
const DEFAULT_HELP = hintMsgEl ? hintMsgEl.innerHTML : '';

let _lastToolMsg = '';  // 记录最近一次 setToolLabel 的消息

/** 设置动态提示消息 */
function setHintMsg(text) {
  if (!hintMsgEl) return;
  if (text) {
    hintMsgEl.textContent = text;
    hintMsgEl.classList.add('dynamic');
  } else {
    hintMsgEl.innerHTML = DEFAULT_HELP;
    hintMsgEl.classList.remove('dynamic');
  }
}

/** 持久工具栏消息（模式、锁定平面等） */
function setToolLabel(text) {
  _lastToolMsg = text;
  setHintMsg(text);
}

/** 临时状态消息；传空则恢复到最近工具栏消息或默认帮助 */
function setStatus(text) {
  if (text) {
    setHintMsg(text);
  } else if (_lastToolMsg) {
    setHintMsg(_lastToolMsg);
  } else {
    setHintMsg('');
  }
}

function clearToolLabel() { _lastToolMsg = ''; setHintMsg(''); }

/* ================================================================
 *  场景
 * ================================================================ */
const { scene, camera, renderer, controls, yAxisHoverMesh, helperGroup } = createScene(canvas3D);
controls.target.set(0, 2, 0);
controls.update();

/* 当前是否处于编辑模式（false = 预览模式） */
let isEditMode = true;

/* ================================================================
 *  全局状态：撤销/重做栈、线条选中、测量、平面指示、多选与上色面
 * ================================================================ */
const undoStack = [];
const redoStack = [];
let   selectedLineId = null;

/** ★ Ctrl+多选球体 */
const multiSelectedKeys = new Set();       // 当前选中的 endpoint key 集合
const multiSelectedMeshes = new Map();     // key → mesh 快速查找
let   currentFace = null;                  // 当前实时预览面（跟随多选变化）
const coloredFaces  = [];                  // 已提交的持久着色面 [{mesh, keySet}]

/** ★ 通用锁定平面信息（统一来源：地面 / 3点 / 多边形顶点）
 *  { normal:THREE.Vector3, center:THREE.Vector3, source:'polygon'|'ground'|'3point' } */
let lockedPlaneInfo = null;

/** ★ 3点定面模式状态 */
let planePickMode = false;                 // 是否处于 3 点拾取模式
let planePickPoints = [];                  // 已拾取的端点 [{mesh, position}]

const measureEl    = document.getElementById('measure-readout');
const exportBtn    = document.getElementById('btn-export');
const importBtn    = document.getElementById('btn-import');
const importFile   = document.getElementById('import-file');
const btnRedo      = document.getElementById('btn-redo');

/* 线条拾取用射线（独立于端点 / 多边形拾取） */
const _lineRaycaster = new THREE.Raycaster();
_lineRaycaster.params.Line  = { threshold: 0.15 };
_lineRaycaster.params.Line2 = { threshold: 0.15 };

/* 平面锁定指示：半透明四边形（编辑且锁定平面时显示） */
const planeIndicator = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })
);
planeIndicator.renderOrder = 0;
planeIndicator.visible = false;
scene.add(planeIndicator);

/* ================================================================
 *  绘制系统
 * ================================================================ */
const lineManager      = new LineManager(scene, renderer);
const brushManager     = new BrushManager(scene, camera);
const drawingController = new DrawingController({
  canvas: renderer.domElement,
  camera,
  scene,
  lineManager,
  onStateChange: () => {},
  polygonPicker,
  onPolygonPicked,
  linePicker,
  onLinePicked,
  onLineFinalized,
  onMeasure,
  onMultiSelect,
});

/* ================================================================
 *  Ctrl+多选球体 + 同面区域上色（功能 10）
 * ================================================================ */

/** Ctrl+点击端点球体的回调 */
function onMultiSelect(key, mesh) {
  if (key === null && mesh === null) {
    // 点击空白 → 清除所有多选
    clearMultiSelect();
    return;
  }
  if (!key) return;

  if (multiSelectedKeys.has(key)) {
    // 取消选中
    multiSelectedKeys.delete(key);
    multiSelectedMeshes.delete(key);
    lineManager.setMultiSelectHighlight(mesh, false);
    setStatus(`已取消选中（剩余 ${multiSelectedKeys.size} 个）`);
  } else {
    // 添加选中
    multiSelectedKeys.add(key);
    multiSelectedMeshes.set(key, mesh);
    lineManager.setMultiSelectHighlight(mesh, true);
    setStatus(`已选中 ${multiSelectedKeys.size} 个端点（Ctrl+点击空白取消）`);
  }
  updateMultiSelectFace();
}

/** 清除所有多选（面的实时预览关闭，已生成的面提交到持久列表） */
function clearMultiSelect() {
  lineManager.clearAllMultiSelectHighlights();

  // ★ 提交当前面到持久列表（去重）
  if (currentFace && multiSelectedKeys.size >= 3) {
    const keySet = new Set(multiSelectedKeys);
    const isDup = coloredFaces.some(f =>
      f.keySet.size === keySet.size && [...keySet].every(k => f.keySet.has(k))
    );
    if (!isDup) {
      coloredFaces.push({ mesh: currentFace, keySet });
    } else {
      // 重复面：直接丢弃
      if (currentFace.geometry) currentFace.geometry.dispose();
      if (currentFace.material) currentFace.material.dispose();
    }
    currentFace = null; // 所有权已转让给 coloredFaces，不再 remove
  } else if (currentFace) {
    // 多选 <3，丢弃无效面
    removeCurrentFace();
  }

  multiSelectedKeys.clear();
  multiSelectedMeshes.clear();

  // 更新状态
  if (coloredFaces.length > 0) {
    setStatus(`${coloredFaces.length} 个区域已上色 — 可继续选球给其他面上色`);
  } else {
    setStatus('');
  }
}

/** 移除当前区域着色面（仅用于实时预览面的生命周期管理） */
function removeCurrentFace() {
  if (currentFace) {
    scene.remove(currentFace);
    if (currentFace.geometry) currentFace.geometry.dispose();
    if (currentFace.material) currentFace.material.dispose();
    currentFace = null;
  }
}

/** 删除所有持久着色面 */
function removeAllColoredFaces() {
  for (const f of coloredFaces) {
    if (f.mesh) {
      scene.remove(f.mesh);
      if (f.mesh.geometry) f.mesh.geometry.dispose();
      if (f.mesh.material) f.mesh.material.dispose();
    }
  }
  coloredFaces.length = 0;
  removeCurrentFace(); // 也清掉实时预览
}

/**
 * 根据当前多选端点，检查共面性并生成着色面
 * - ≥3 个且共面 → 生成 semi-transparent 彩色面
 * - 否则 → 移除面
 */
function updateMultiSelectFace() {
  removeCurrentFace();
  if (multiSelectedKeys.size < 3) return;

  // 收集选中端点的世界坐标
  const points = [];
  for (const [, mesh] of multiSelectedMeshes) {
    points.push(mesh.position.clone());
  }

  // 共面检查：以前 3 点确定的平面为参考
  if (!areCoplanar(points, 0.08)) {
    setStatus(`已选中 ${multiSelectedKeys.size} 个端点 — 不共面，无法上色`);
    return;
  }

  // 生成着色面
  currentFace = createFaceForPoints(points, lineManager.currentColor);
  if (currentFace) {
    scene.add(currentFace);
    setStatus(`已选中 ${multiSelectedKeys.size} 个端点 — 已上色区域`);
  }
}

/**
 * 判断一组点是否共面（不共线且最大偏差 < threshold）
 */
function areCoplanar(points, threshold) {
  if (points.length < 3) return false;

  // 取前两个方向向量
  const a = points[1].clone().sub(points[0]);
  const b = points[2].clone().sub(points[0]);
  const normal = new THREE.Vector3().crossVectors(a, b);

  // 三点共线 → 无法确定平面
  if (normal.length() < 0.0001) {
    // 尝试用后面不共线的点
    for (let i = 3; i < points.length; i++) {
      b.copy(points[i]).sub(points[0]);
      normal.crossVectors(a, b);
      if (normal.length() > 0.0001) break;
    }
    if (normal.length() < 0.0001) return false; // 所有点共线
  }
  normal.normalize();

  // 检查其他点到该平面的距离
  const planePoint = points[0];
  for (let i = 0; i < points.length; i++) {
    const dist = Math.abs(
      new THREE.Vector3().subVectors(points[i], planePoint).dot(normal)
    );
    if (dist > threshold) return false;
  }
  return true;
}

/**
 * 对一组共面点生成着色面 Mesh
 * 1. 投影到最佳拟合平面
 * 2. 按角度排序
 * 3. 扇形三角剖分
 */
function createFaceForPoints(positions, color) {
  if (positions.length < 3) return null;

  // 计算质心
  const centroid = new THREE.Vector3();
  for (const p of positions) centroid.add(p);
  centroid.divideScalar(positions.length);

  // 计算法向（用前两个不共线方向）
  const a = positions[1].clone().sub(positions[0]);
  const b = positions[2].clone().sub(positions[0]);
  const normal = new THREE.Vector3().crossVectors(a, b).normalize();
  if (normal.length() < 0.0001) return null;

  // 构建面内局部坐标系
  const u = a.normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();

  // 投影到平面并转 2D
  const projected = positions.map(p => {
    const d = p.clone().sub(centroid);
    return {
      x: d.dot(u),
      y: d.dot(v),
      original: p,
    };
  });

  // 按角度排序（atan2 绕质心）
  projected.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));

  // 扇形三角剖分（从质心出发）
  const n = projected.length;
  const verts = [];
  const idx = [];
  // 质心 → 索引 0
  verts.push(centroid.x, centroid.y, centroid.z);
  for (const p of projected) {
    verts.push(p.original.x, p.original.y, p.original.z);
  }
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    idx.push(0, i + 1, next + 1);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    color: color ?? lineManager.currentColor,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 1;
  mesh.name = 'coloredFace';
  return mesh;
}
const polygonGroups   = []; // { center, radius, sides, vertices, edges, anchorKeys, sphereMeshes }

// 双击绿色坐标轴生成的独立圆球（连线节点），与辅助多边形分开管理
const freeSpheres   = []; // { key, mesh }

// ★ 辅助样式：虚线灰白 + 小球透明灰
function createDashedLineMat() {
  return new THREE.LineDashedMaterial({
    color: 0x888888,
    transparent: true,
    opacity: 0.5,
    dashSize: 0.4,
    gapSize: 0.25,
    depthTest: true,
  });
}

function createHelperSphereMat() {
  return new THREE.MeshBasicMaterial({
    color: 0xaaaaaa,
    transparent: true,
    opacity: 0.4,
    depthTest: true,
    depthWrite: false,
  });
}

/** 在 XZ 平面上（垂直 Y 轴）生成正多边形辅助线（n=2 时为辅助直线） */
function createPolygonOnYAxis(centerY, radius, sides) {
  const n  = Math.max(2, Math.min(32, sides));
  const R  = Math.max(0.2, Math.min(20, radius));
  const vertices = [];

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    vertices.push(new THREE.Vector3(R * Math.cos(angle), centerY, R * Math.sin(angle)));
  }

  const anchorKeys  = [];
  const sphereMeshes = [];
  const edgeGroup   = new THREE.Group();
  edgeGroup.name = 'polygonEdges';
  scene.add(edgeGroup);

  // ★ 顶点球体 —— 辅助样式灰色半透，同时注册为吸附端点
  for (let i = 0; i < n; i++) {
    // 注册到端点系统（可被画线吸附）
    const { key } = lineManager.addAnchorPoint(vertices[i], 0xaaaaaa, 0.12);
    anchorKeys.push(key);

    // 额外覆盖为辅助视觉样式
    const epIdx = lineManager.getEndpointMeshes().length - 1;
    const m = lineManager.getEndpointMeshes()[epIdx];
    m.material.color.set(0xaaaaaa);
    m.material.opacity = 0.4;
    sphereMeshes.push(m);
  }

  // ★ 边（n≥3 闭合多边形，n=2 为一条直线）
  const points = n >= 3 ? [...vertices, vertices[0]] : vertices;
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(geom, createDashedLineMat());
  line.computeLineDistances();
  edgeGroup.add(line);

  // ★ 中心标记（半透灰）
  const centerGeom = new THREE.SphereGeometry(0.06, 12, 12);
  const centerMarker = new THREE.Mesh(centerGeom, createHelperSphereMat());
  centerMarker.position.set(0, centerY, 0);
  edgeGroup.add(centerMarker);

  // ★ 拾取用隐形面（n≥3 时有效，n=2 退化为线段故跳过）
  let faceMesh = null;
  if (n >= 3) {
    const facePositions = [];
    for (let i = 0; i < n; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      facePositions.push(0, centerY, 0, a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const faceGeom = new THREE.BufferGeometry();
    faceGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(facePositions), 3));
    faceMesh = new THREE.Mesh(
      faceGeom,
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide })
    );
    faceMesh.renderOrder = -1;
    edgeGroup.add(faceMesh);
  }

  const group = {
    center: new THREE.Vector3(0, centerY, 0),
    radius: R,
    sides: n,
    vertices: vertices.map(v => v.clone()),
    anchorKeys,
    sphereMeshes,
    edgeGroup,
    faceMesh,
  };

  // 顶点锚点关联回所属多边形，便于点击顶点时选中
  sphereMeshes.forEach(m => { m.userData.polygonGroup = group; });

  polygonGroups.push(group);

  // 若当前处于预览模式，新建的辅助图案直接隐藏
  if (!isEditMode) {
    group.edgeGroup.visible = false;
    group.sphereMeshes.forEach(m => { m.visible = false; });
  }

  setToolLabel(`\u5df2\u751f\u6210\u6b63${n}\u8fb9\u5f62  \u534a\u5f84=${R.toFixed(1)}  \u2014 \u53ef\u753b\u7ebf\u5bf9\u63a5\u9876\u70b9\u7403\u4f53`);
  return group;
}

/** 清空所有辅助多边形 */
function removeAllPolygons() {
  for (const g of polygonGroups) {
    for (const key of g.anchorKeys) {
      lineManager.removeAnchorPoint(key);
    }
    scene.remove(g.edgeGroup);
    // 清理子对象
    while (g.edgeGroup.children.length) {
      const child = g.edgeGroup.children[0];
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      g.edgeGroup.remove(child);
    }
  }
  polygonGroups.length = 0;
}

/* ---- 独立圆球（双击 Y 轴生成，连线节点） ---- */
function clearFreeSpheres() {
  for (const s of freeSpheres) lineManager.removeAnchorPoint(s.key);
  freeSpheres.length = 0;
}

/** 静默在某个坐标创建独立圆球（导入重建用，不记历史） */
function addFreeSphereAt(pos, color) {
  const { key, mesh } = lineManager.addAnchorPoint(pos.clone(), color ?? lineManager.currentColor, 0.15);
  freeSpheres.push({ key, mesh, type: 'ball', radius: 0.15, color: color ?? lineManager.currentColor });
  return key;
}

/** 双击 Y 轴生成独立圆球（带历史，可撤销） */
function createFreeSphere(point) {
  if (!isEditMode) return;
  const pos = point.clone();
  const { key, mesh } = lineManager.addAnchorPoint(pos, lineManager.currentColor, 0.15);
  freeSpheres.push({ key, mesh, type: 'ball', radius: 0.15, color: lineManager.currentColor });
  pushHistory(
    () => { removeFreeSphereByKey(key); },
    () => { const r = lineManager.addAnchorPoint(pos, lineManager.currentColor, 0.15); freeSpheres.push({ key: r.key, mesh: r.mesh, type: 'ball', radius: 0.15, color: lineManager.currentColor }); return r.key; }
  );
  setStatus('已在绿色坐标轴生成圆球');
  setToolLabel('已在绿色坐标轴生成圆球 - 可作为连线节点');
}

/** 按 key 删除独立圆球（撤销用） */
function removeFreeSphereByKey(key) {
  const idx = freeSpheres.findIndex(s => s.key === key);
  if (idx !== -1) freeSpheres.splice(idx, 1);
  lineManager.removeAnchorPoint(key);
}

/** 当前圆球半径（由滑块控制，影响新生成圆球大小） */
let currentBallRadius = 0.25;
const DOT_COLOR = 0xcccccc;   // 圆点：浅灰

/** 计算空白点击对应的空间坐标（投影到当前绘制平面） */
function computeBlankPoint(mouse) {
  // 平面锁定 → 射线与锁定平面求交
  if (drawingController.planeLocked && drawingController.lockedPlane) {
    focusRaycaster.setFromCamera(mouse, camera);
    const pt = new THREE.Vector3();
    return focusRaycaster.ray.intersectPlane(drawingController.lockedPlane, pt) ? pt : null;
  }
  // 自由模式 → 相机前方 5 单位处构造投影平面
  const viewDir = new THREE.Vector3();
  camera.getWorldDirection(viewDir);
  const planeCenter = camera.position.clone().add(viewDir.clone().multiplyScalar(5));
  let normal;
  if (drawingController.freePlaneMode === 'horizontal') {
    normal = new THREE.Vector3(0, 1, 0);
  } else {
    normal = viewDir.clone();
  }
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planeCenter);
  focusRaycaster.setFromCamera(mouse, camera);
  const pt = new THREE.Vector3();
  return focusRaycaster.ray.intersectPlane(plane, pt) ? pt : null;
}

/* ---- Alt+拖拽移动圆点/圆球（连线跟随） ---- */
let _endpointDrag = null;  // { key, originPos, plane }

/** 开始拖拽端点 */
function startEndpointDrag(key, mesh, mouse) {
  const originPos = lineManager.getEndpointPosition(key);
  if (!originPos) return;

  // 构造投影平面（与 computeBlankPoint 一致：锁定平面优先，否则镜头面/水平面）
  let plane;
  if (drawingController.planeLocked && drawingController.lockedPlane) {
    plane = drawingController.lockedPlane.clone();
  } else {
    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const planeCenter = mesh.position.clone();
    const normal = drawingController.freePlaneMode === 'horizontal'
      ? new THREE.Vector3(0, 1, 0)
      : viewDir.clone();
    plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planeCenter);
  }

  _endpointDrag = { key, originPos: originPos.clone(), plane };

  const onMove = (ev) => {
    if (!_endpointDrag) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    focusRaycaster.setFromCamera(m, camera);
    const pt = new THREE.Vector3();
    if (focusRaycaster.ray.intersectPlane(_endpointDrag.plane, pt)) {
      lineManager.moveEndpoint(_endpointDrag.key, pt);
    }
    ev.stopPropagation();
    ev.preventDefault();
  };

  const onUp = (ev) => {
    if (!_endpointDrag) return;
    const drag = _endpointDrag;
    _endpointDrag = null;
    renderer.domElement.removeEventListener('pointermove', onMove, true);
    renderer.domElement.removeEventListener('pointerup', onUp, true);
    // 记录撤销历史：撤销=回到原位，重做=移到新位
    const newPos = lineManager.getEndpointPosition(drag.key);
    if (newPos && newPos.distanceTo(drag.originPos) > 0.001) {
      const orig = drag.originPos.clone();
      const k = drag.key;
      pushHistory(
        () => lineManager.moveEndpoint(k, orig),
        () => lineManager.moveEndpoint(k, newPos)
      );
      setStatus('已移动圆点 - Ctrl+Z 撤销');
    }
    ev.stopPropagation();
    ev.preventDefault();
  };

  renderer.domElement.addEventListener('pointermove', onMove, true);
  renderer.domElement.addEventListener('pointerup', onUp, true);
}

/** 双击空白生成圆点（小编辅锚点，可吸附连线） */
function createFreeDot(pos) {
  const radius = 0.1;
  const color = DOT_COLOR;
  const { key, mesh } = lineManager.addAnchorPoint(pos.clone(), color, radius);
  mesh.userData._type = 'dot';
  freeSpheres.push({ key, mesh, type: 'dot', radius, color, pos: pos.clone() });
  pushHistory(
    () => { removeFreeSphereByKey(key); },
    () => { const r = lineManager.addAnchorPoint(pos, color, radius); r.mesh.userData._type = 'dot'; freeSpheres.push({ key: r.key, mesh: r.mesh, type: 'dot', radius, color, pos: pos.clone() }); return r.key; }
  );
  setStatus('已生成圆点 - 可作为连线节点吸附');
}

/** Shift+双击空白生成圆球（大3D球体，大小由滑块控制） */
function createFreeBall(pos) {
  const radius = currentBallRadius;
  const color = lineManager.currentColor;
  const { key, mesh } = lineManager.addAnchorPoint(pos.clone(), color, radius);
  mesh.userData._type = 'ball';
  freeSpheres.push({ key, mesh, type: 'ball', radius, color, pos: pos.clone() });
  pushHistory(
    () => { removeFreeSphereByKey(key); },
    () => { const r = lineManager.addAnchorPoint(pos, color, radius); r.mesh.userData._type = 'ball'; freeSpheres.push({ key: r.key, mesh: r.mesh, type: 'ball', radius, color, pos: pos.clone() }); return r.key; }
  );
  setStatus('已生成圆球 - 可作为连线节点吸附');
}

/** 带历史记录地删除独立圆点/圆球（右键删除用） */
function deleteFreeSphereWithHistory(key) {
  const item = freeSpheres.find(s => s.key === key);
  if (!item) return;
  const pos = item.mesh.position.clone();
  const type = item.type || 'ball';
  const radius = item.radius || 0.15;
  const color = item.color ?? lineManager.currentColor;
  removeFreeSphereByKey(key);
  pushHistory(
    () => {
      const r = lineManager.addAnchorPoint(pos, color, radius);
      r.mesh.userData._type = type;
      freeSpheres.push({ key: r.key, mesh: r.mesh, type, radius, color, pos: pos.clone() });
    },
    () => { removeFreeSphereByKey(key); }
  );
}

/* ================================================================
 *  线条选中 / 测量 / 平面指示 / 撤销重做 / 导入导出  （功能 3,4,6,7,8,9）
 * ================================================================ */

/** 清除线条选中（取消高亮 + 隐藏测量读数） */
function clearLineSelection() {
  lineManager.clearLineHighlight();
  selectedLineId = null;
  if (measureEl) { measureEl.textContent = ''; measureEl.style.display = 'none'; }
}

/** 刷新平面锁定指示四边形（编辑且锁定平面时显示）
 *  支持任意平面方向：优先用 lockedPlaneInfo（地面 / 3点 / 多边形顶点统一来源） */
function updatePlaneIndicator() {
  if (!isEditMode) { planeIndicator.visible = false; return; }

  let normal = null, center = null;

  if (lockedPlaneInfo) {
    // 通用锁定平面（地面 / 3点 / 多边形顶点）
    normal = lockedPlaneInfo.normal;
    center = lockedPlaneInfo.center;
  }

  if (normal && drawingController.planeLocked) {
    planeIndicator.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    planeIndicator.position.copy(center);
    planeIndicator.visible = true;
  } else {
    planeIndicator.visible = false;
  }
}

/** 拾取线条：返回 lineId 或 null（由 DrawingController 在 IDLE 点击时调用） */
function linePicker(mouse, cam) {
  if (!isEditMode) return null;
  _lineRaycaster.setFromCamera(mouse, cam);
  const objs = lineManager.getLineObjects();
  if (!objs.length) return null;
  const hits = _lineRaycaster.intersectObjects(objs.map(o => o.object), false);
  if (!hits.length) return null;
  return hits[0].object.userData.lineId || null;
}

/** 选中 / 取消选中某条线（id 为 null 表示清除选中） */
function onLinePicked(id) {
  if (id === null || id === undefined) {
    clearLineSelection();
    return;
  }
  if (id !== selectedLineId) {
    lineManager.clearLineHighlight();
    selectedLineId = id;
    lineManager.setLineHighlight(id);
  }
  showSelectedLineMeasure(id);
}

/** 线条定稿回调：记录撤销快照 */
function onLineFinalized(lineData, mode) {
  const snap = {
    controlPoints: lineData.points.map(p => [p.x, p.y, p.z]),
    color: lineData.color,
    widthKey: lineData.widthKey || 'thin',
    mode,
    finalized: false, // 原始绘制轨迹，重做时按原模式重新定稿
  };
  const lineId = lineData.id;
  pushHistory(
    () => { lineManager.deleteLine(lineId); if (selectedLineId === lineId) clearLineSelection(); },
    () => { const nid = lineManager.recreateLine(snap); return nid; }
  );
}

/** 测量读数回调：info=null 清除；{kind,length} 显示实时长度 */
function onMeasure(info) {
  if (!measureEl) return;
  if (!info) { measureEl.textContent = ''; measureEl.style.display = 'none'; return; }
  measureEl.textContent = `长度 ${info.length.toFixed(2)}`;
  measureEl.style.display = 'block';
}

/** 显示选中线条的长度与俯仰角 */
function showSelectedLineMeasure(id) {
  if (!measureEl) return;
  const len = lineManager.getLineLength(id);
  let txt = `长度 ${len.toFixed(2)}`;
  const eps = lineManager.getLineEndpoints(id);
  if (eps) {
    const d = eps.end.clone().sub(eps.start);
    const horiz = Math.hypot(d.x, d.z);
    const pitch = Math.atan2(d.y, horiz) * 180 / Math.PI;
    txt += `  |  俯仰角 ${pitch.toFixed(1)}°`;
  }
  measureEl.textContent = txt;
  measureEl.style.display = 'block';
}

/** 把已定稿线条打包为快照（finalized=true，重做时按原样重建避免二次平滑） */
function makeFinalizedSnapshot(data) {
  return {
    controlPoints: data.points.map(p => [p.x, p.y, p.z]),
    color: data.color,
    widthKey: data.widthKey || 'thin',
    mode: data.mode || DrawMode.FREEHAND,
    finalized: true,
  };
}

/* ---- 撤销 / 重做栈 ---- */
function pushHistory(undoFn, redoFn) {
  undoStack.push({ undo: undoFn, redo: redoFn });
  redoStack.length = 0;
  updateHistoryButtons();
}
function doUndo() {
  const action = undoStack.pop();
  if (!action) { setStatus('没有可撤销的操作'); return; }
  action.undo();
  redoStack.push(action);
  updateHistoryButtons();
  setStatus('已撤销');
}
function doRedo() {
  const action = redoStack.pop();
  if (!action) { setStatus('没有可重做的操作'); return; }
  action.redo();
  undoStack.push(action);
  updateHistoryButtons();
  setStatus('已重做');
}

/** 删除单条选中线条（带历史） */
function deleteSingleLine(lineId) {
  const data = lineManager.getLineData(lineId);
  if (!data) return;
  const snap = makeFinalizedSnapshot(data);
  let recreatedId = null;
  pushHistory(
    () => { recreatedId = lineManager.recreateLine(snap); return recreatedId; },
    () => { if (recreatedId) lineManager.deleteLine(recreatedId); if (selectedLineId === recreatedId) clearLineSelection(); }
  );
  lineManager.deleteLine(lineId);
  if (selectedLineId === lineId) clearLineSelection();
}

/** 清空所有线条（带历史，保留辅助多边形） */
function clearAllLinesWithHistory() {
  const snaps = lineManager.serializeLines();
  if (!snaps.length) { setStatus('没有可清空的线条'); return; }
  pushHistory(
    () => { for (const s of snaps) lineManager.recreateLine(s); },
    () => { for (const [, d] of [...lineManager.lines]) lineManager.deleteLine(d.id); if (selectedLineId) clearLineSelection(); }
  );
  lineManager.clearLinesOnly();
  clearLineSelection();
  setStatus('已清空所有绘制的线条');
}

/* ---- 辅助多边形：增删（带历史） ---- */
function polygonSpec(group) {
  return { centerY: group.center.y, radius: group.radius, sides: group.sides };
}

/** 安静地移除多边形（撤销多边形创建 / 导入重建时用，不再记录历史） */
function removePolygonQuiet(group) {
  const idx = polygonGroups.indexOf(group);
  if (idx !== -1) polygonGroups.splice(idx, 1);
  for (const key of group.anchorKeys) lineManager.removeAnchorPoint(key);
  scene.remove(group.edgeGroup);
  while (group.edgeGroup.children.length) {
    const c = group.edgeGroup.children[0];
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
    group.edgeGroup.remove(c);
  }
  if (activePolygon === group) clearPolygonSelection();
}

/** 创建多边形（带历史，供右键弹窗调用） */
function addPolygonWithHistory(centerY, radius, sides) {
  const group = createPolygonOnYAxis(centerY, radius, sides);
  const spec = polygonSpec(group);
  pushHistory(
    () => { removePolygonQuiet(group); },
    () => { const g = createPolygonOnYAxis(spec.centerY, spec.radius, spec.sides); return g; }
  );
  return group;
}

/** 删除选中多边形（带历史） */
function removePolygonWithHistory(group) {
  const spec = polygonSpec(group);
  let recreatedG = null;
  pushHistory(
    () => { recreatedG = createPolygonOnYAxis(spec.centerY, spec.radius, spec.sides); return recreatedG; },
    () => { if (recreatedG) removePolygonQuiet(recreatedG); if (activePolygon === recreatedG) clearPolygonSelection(); }
  );
  removePolygonQuiet(group);
}

/** 清空所有多边形（带历史，需确认） */
function clearAllPolygonsWithHistory() {
  const specs = polygonGroups.map(polygonSpec);
  if (!specs.length) return;
  pushHistory(
    () => { for (const s of specs) createPolygonOnYAxis(s.centerY, s.radius, s.sides); },
    () => { for (const g of [...polygonGroups]) removePolygonQuiet(g); clearPolygonSelection(); }
  );
  for (const g of [...polygonGroups]) removePolygonQuiet(g);
  clearPolygonSelection();
}

/* ---- 场景导入 / 导出（功能 7） ---- */
function exportScene() {
  const data = {
    version: 1,
    lines: lineManager.serializeLines(),
    polygons: polygonGroups.map(polygonSpec),
    freeSpheres: freeSpheres.map(s => ({
      pos: [s.mesh.position.x, s.mesh.position.y, s.mesh.position.z],
      type: s.type || 'ball',
      radius: s.radius || 0.15,
      color: s.color ?? lineManager.currentColor,
    })),
    camera: {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
    },
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scene.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('已导出场景 JSON');
}

function importScene(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const prevLines = lineManager.serializeLines();
      const prevPolys = polygonGroups.map(polygonSpec);
      const prevFree  = freeSpheres.map(s => ({ pos: [s.mesh.position.x, s.mesh.position.y, s.mesh.position.z], type: s.type || 'ball', radius: s.radius || 0.15, color: s.color ?? lineManager.currentColor }));
      // 还原/应用独立节点（兼容旧数组格式 [x,y,z] 与新对象格式 {pos,type,radius,color}）
      const restoreNode = (item) => {
        if (Array.isArray(item)) {
          addFreeSphereAt(new THREE.Vector3(item[0], item[1], item[2]));
        } else {
          const { key, mesh } = lineManager.addAnchorPoint(new THREE.Vector3(item.pos[0], item.pos[1], item.pos[2]), item.color ?? lineManager.currentColor, item.radius || 0.15);
          mesh.userData._type = item.type || 'ball';
          freeSpheres.push({ key, mesh, type: item.type || 'ball', radius: item.radius || 0.15, color: item.color ?? lineManager.currentColor });
        }
      };
      const restore = () => {
        lineManager.clearLinesOnly();
        for (const g of [...polygonGroups]) removePolygonQuiet(g);
        clearFreeSpheres();
        clearPolygonSelection();
        for (const s of prevLines) lineManager.recreateLine(s);
        for (const p of prevPolys) createPolygonOnYAxis(p.centerY, p.radius, p.sides);
        for (const p of prevFree)  restoreNode(p);
      };
      const apply = () => {
        lineManager.clearLinesOnly();
        for (const g of [...polygonGroups]) removePolygonQuiet(g);
        clearFreeSpheres();
        clearPolygonSelection();
        for (const s of (data.lines || [])) lineManager.recreateLine(s);
        for (const p of (data.polygons || [])) createPolygonOnYAxis(p.centerY, p.radius, p.sides);
        for (const p of (data.freeSpheres || [])) restoreNode(p);
        if (data.camera) {
          camera.position.set(...data.camera.pos);
          controls.target.set(...data.camera.target);
        }
      };
      pushHistory(restore, apply);
      apply();
      clearLineSelection();
      setStatus('已导入场景');
    } catch (err) {
      setStatus('导入失败：JSON 解析错误');
    }
  };
  reader.readAsText(file);
}

/* 导出 / 导入 按钮接线 */
if (exportBtn) exportBtn.addEventListener('click', exportScene);
if (importBtn) importBtn.addEventListener('click', () => importFile && importFile.click());
if (importFile) importFile.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importScene(f);
  e.target.value = '';
});


/* ================================================================
 *  编辑 / 预览 模式
 * ================================================================ */
const modeBtn = document.getElementById('btn-mode');

/** 设置所有辅助多边形的可见性（边 / 拾取面 / 顶点球） */
function setPolygonsHelperVisible(on) {
  for (const g of polygonGroups) {
    g.edgeGroup.visible = on;
    g.sphereMeshes.forEach(m => { m.visible = on; });
  }
}

/** 进入 / 退出 预览模式 */
function setEditMode(on) {
  isEditMode = on;
  // 退出 3 点拾取模式 / 隐藏平面模式栏（预览模式）
  if (!on) exitPlanePickModeSilent();
  if (pmBar) pmBar.style.display = on ? 'flex' : 'none';
  // 辅助图层（坐标轴 / 网格 / 原点 / Y 轴 hover）
  helperGroup.visible = on;
  // 辅助多边形
  setPolygonsHelperVisible(on);
  // 着色面（实时预览 + 持久面）
  if (currentFace) currentFace.visible = on;
  for (const f of coloredFaces) {
    if (f.mesh) f.mesh.visible = on;
  }
  // 线条端点球：预览模式下隐藏，仅看绘画线条（功能 9）
  lineManager.setEndpointBallsVisible(on);
  // 独立圆球：预览模式隐藏（属于辅助节点，保持画面干净）
  for (const s of freeSpheres) s.mesh.visible = on;
  // 绘制交互
  drawingController.setEnabled(on);
  // Y 轴 hover 关闭
  if (!on) {
    yAxisHovered = false;
    setYAxisVisual(false);
    lineManager.hideSnapIndicator();
  }
  // 预览模式隐藏平面切换栏并解除选中
  if (!on) {
    hidePlaneBar();
    clearPolygonSelection();
    clearLineSelection();
  }
  // 平面指示随模式刷新
  updatePlaneIndicator();
  // 更新按钮样式
  modeBtn.textContent = on ? '编辑模式' : '预览模式';
  modeBtn.classList.toggle('active', on);
  modeBtn.classList.toggle('preview', !on);
  setToolLabel(on
    ? '编辑模式 - 点击辅助多边形可选择平面，点击空白绘制'
    : '预览模式 - 仅查看绘画效果（辅助图案已隐藏）');
}

modeBtn.addEventListener('click', () => {
  setEditMode(!isEditMode);
});

/* ================================================================
 *  工具栏按钮接线（绘制模式 / 颜色 / 线宽 / 撤销 / 清空）
 *  - 所有按钮在编辑与预览模式下都可点击；预览模式仅禁止实际绘制
 *    （由 DrawingController.enabled 拦截），不再整体变灰。
 * ================================================================ */

// ---- 绘制模式：随手画 / 直线 / 曲线 / 笔刷 ----
const drawModeBtns = {
  freehand: document.getElementById('btn-freehand'),
  straight: document.getElementById('btn-straight'),
  curve:    document.getElementById('btn-curve'),
  brush:    document.getElementById('btn-brush'),
};
const drawModeLabels = { freehand: '随手画', straight: '直线', curve: '曲线', brush: '笔刷' };

function setActiveDrawMode(mode) {
  if (mode === 'brush') {
    // 切换到笔刷模式
    drawingController.setBrushMode(true, brushManager);
    for (const [m, btn] of Object.entries(drawModeBtns)) {
      btn.classList.toggle('active', m === mode);
    }
    if (isEditMode) {
      setToolLabel('笔刷模式 - 选中辅助多边形平面后拖拽绘制墨迹');
    }
    return;
  }
  // 非笔刷模式：关闭笔刷
  drawingController.setBrushMode(false, null);
  drawingController.setMode(mode);
  for (const [m, btn] of Object.entries(drawModeBtns)) {
    btn.classList.toggle('active', m === mode);
  }
  if (isEditMode) {
    setToolLabel(`绘制模式 - ${drawModeLabels[mode]}（点击空白区域开始绘制）`);
  } else {
    setToolLabel(`预览模式 - 已选「${drawModeLabels[mode]}」，切回编辑模式后生效`);
  }
}
for (const [mode, btn] of Object.entries(drawModeBtns)) {
  btn.addEventListener('click', () => setActiveDrawMode(mode));
}
setActiveDrawMode(lineManager.currentDrawMode);

// ---- 颜色 ----
const colorSwatchesEl = document.getElementById('color-swatches');
const colorPicker     = document.getElementById('color-picker');

COLOR_PALETTE.forEach((hex, i) => {
  const css = '#' + hex.toString(16).padStart(6, '0');
  const sw = document.createElement('div');
  sw.className = 'color-swatch';
  sw.style.background = css;
  sw.style.color = css; // 用于 active 时的辉光
  sw.title = css;
  sw.addEventListener('click', () => {
    lineManager.setColor(hex);
    colorPicker.value = css;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
  });
  colorSwatchesEl.appendChild(sw);
  if (i === 0) sw.classList.add('active');
});
colorPicker.addEventListener('input', () => {
  lineManager.setColor(parseInt(colorPicker.value.slice(1), 16));
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
});

// ---- 线宽 / 球径：滑块精细调整 ----
const lineWidthEl  = document.getElementById('line-width');
const lwValEl      = document.getElementById('lw-val');
const ballRadiusEl = document.getElementById('ball-radius');
const brValEl      = document.getElementById('br-val');

// 初始化为滑块值（与 LineManager 默认 currentPixelWidth 一致）
lineManager.setLineWidth(parseInt(lineWidthEl.value, 10));
lwValEl.textContent = lineWidthEl.value;

lineWidthEl.addEventListener('input', () => {
  const v = parseInt(lineWidthEl.value, 10);
  lineManager.setLineWidth(v);
  lwValEl.textContent = v;
});

ballRadiusEl.addEventListener('input', () => {
  currentBallRadius = parseFloat(ballRadiusEl.value);
  brValEl.textContent = currentBallRadius.toFixed(2);
});

// ---- 撤销 / 清空 ----
const btnUndo     = document.getElementById('btn-undo');
const btnClearAll = document.getElementById('btn-clear-all');

btnUndo.addEventListener('click', () => doUndo());
btnRedo.addEventListener('click', () => doRedo());

btnClearAll.addEventListener('click', () => {
  clearAllLinesWithHistory();
});

function updateHistoryButtons() {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
}

/* ================================================================
 *  辅助多边形拾取 + 平面锁定绘制
 * ================================================================ */
const _pickRaycaster = new THREE.Raycaster();

/** 拾取辅助多边形面（仅编辑模式有效） */
function polygonPicker(mouse, camera) {
  if (!isEditMode) return null;
  _pickRaycaster.setFromCamera(mouse, camera);
  const faces = [];
  for (const g of polygonGroups) {
    if (g.faceMesh) faces.push(g.faceMesh);
  }
  if (faces.length === 0) return null;
  const hits = _pickRaycaster.intersectObjects(faces, false);
  if (!hits.length) return null;
  const face = hits[0].object;
  const group = polygonGroups.find(g => g.faceMesh === face);
  return group ? { group, point: hits[0].point.clone() } : null;
}

/* ---- 选中状态 ---- */
let activePolygon = null;     // 当前选中的辅助多边形 group
let activeVertexIndex = 0;    // 当前平面所基于的顶点索引

const planeBar   = document.getElementById('plane-bar');
const btnPlaneL  = document.getElementById('btn-plane-left');
const btnPlaneM  = document.getElementById('btn-plane-mid');
const btnPlaneR  = document.getElementById('btn-plane-right');

function showPlaneBar()  { planeBar.style.display = 'flex'; }
function hidePlaneBar()  { planeBar.style.display = 'none'; }

/** 清空选中（解除平面锁定、隐藏栏）
 *  ★ 统一解锁：同时清除多边形状态、通用锁定平面信息、平面指示与模式栏 UI */
function clearPolygonSelection() {
  activePolygon = null;
  activeVertexIndex = 0;
  drawingController.clearLockedPlane();
  lockedPlaneInfo = null;
  btnPlaneM.classList.remove('active');
  btnPlaneM.textContent = '● 锁定平面';
  updatePlaneIndicator();
  updatePlaneModeBarUI();
}

/** 选中某个辅助多边形 */
function onPolygonPicked(group, point) {
  // ★ 多边形平面锁定已移除：锁定平面只通过"3点定面"按钮触发。
  //   多边形顶点圆点 = 普通端点，可吸附续画，但不锁定平面、不转视角。
  clearLineSelection();
  activePolygon = group;
  setToolLabel(`已选中 ${group.sides} 边形 - 顶点圆点可作为普通端点吸附画线`);
}

/** 切换到“绿色坐标轴(Y轴) 与指定顶点共同决定的平面”，并锁定绘制 */
function lockPlaneToVertex(group, index, autoFocus = true) {
  const V = group.vertices[index];
  // 水平方向单位向量（从中心指向该顶点）
  const d = new THREE.Vector3(V.x, 0, V.z).normalize();
  // 包含 Y 轴且过该顶点的竖直平面法线 = (d.z, 0, -d.x)
  const normal = new THREE.Vector3(d.z, 0, -d.x);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(0, 0, 0));
  drawingController.setLockedPlane(plane);
  // ★ 同步通用锁定平面信息（source='polygon' 供指示器与模式栏识别）
  lockedPlaneInfo = { normal: normal.clone(), center: group.center.clone(), source: 'polygon' };
  if (autoFocus) focusPlaneCamera(group, index);
  updatePlaneIndicator();
}

function unlockPlane() {
  drawingController.clearLockedPlane();
  updatePlaneIndicator();
}

/** 转动相机到该平面的正对面（绿色坐标轴竖直居中） */
function focusPlaneCamera(group, index) {
  const center = group.center.clone();
  const V = group.vertices[index];
  const d = new THREE.Vector3(V.x, 0, V.z).normalize();
  const normal = new THREE.Vector3(d.z, 0, -d.x);
  const dist = 12;
  const posTo = center.clone().add(normal.multiplyScalar(dist));
  posTo.y = center.y + 1.5;
  camTween = { posTo, targetTo: center.clone() };
}

function updatePlaneBarUI() {
  const locked = drawingController.planeLocked;
  btnPlaneM.classList.toggle('active', locked);
  btnPlaneM.textContent = locked ? '● 已锁定' : '● 锁定平面';
}

/* ---- 平面切换栏按钮 ---- */
btnPlaneM.addEventListener('click', () => {
  if (!activePolygon) return;
  if (drawingController.planeLocked) {
    unlockPlane();
    setToolLabel('已解除平面锁定 - 恢复自由绘制');
  } else {
    lockPlaneToVertex(activePolygon, activeVertexIndex);
    setToolLabel(`已锁定平面 - 顶点 #${activeVertexIndex + 1}，后续绘制均在此平面`);
  }
  updatePlaneBarUI();
});

btnPlaneL.addEventListener('click', () => {
  if (!activePolygon) return;
  const n = activePolygon.sides;
  activeVertexIndex = (activeVertexIndex - 1 + n) % n; // 逆时针：上一个顶点
  lockPlaneToVertex(activePolygon, activeVertexIndex);
  updatePlaneBarUI();
  setToolLabel(`已切换平面 - 顶点 #${activeVertexIndex + 1}（逆时针）`);
});

btnPlaneR.addEventListener('click', () => {
  if (!activePolygon) return;
  const n = activePolygon.sides;
  activeVertexIndex = (activeVertexIndex + 1) % n; // 顺时针：下一个顶点
  lockPlaneToVertex(activePolygon, activeVertexIndex);
  updatePlaneBarUI();
  setToolLabel(`已切换平面 - 顶点 #${activeVertexIndex + 1}（顺时针）`);
});

/* ================================================================
 *  独立平面模式栏（镜头面 / 水平面 / 地面 / 3点定面 / 解锁）
 *  - 镜头面、水平面：自由绘制（非锁定），决定 intersectProjectionPlane 投影方式
 *  - 地面、3点定面：锁定到具体平面，所有绘制点共面
 * ================================================================ */
const pmBar       = document.getElementById('plane-mode-bar');
const pmCamera    = document.getElementById('pm-camera');
const pmHorizontal= document.getElementById('pm-horizontal');
const pmGround    = document.getElementById('pm-ground');
const pm3Point    = document.getElementById('pm-3point');
const pmUnlock    = document.getElementById('pm-unlock');

/** 刷新平面模式栏按钮的 active / disabled 状态 */
function updatePlaneModeBarUI() {
  const locked = drawingController.planeLocked;
  pmUnlock.disabled = !locked;

  // 自由模式按钮：仅在未锁定时高亮当前自由模式
  const free = drawingController.freePlaneMode;
  pmCamera.classList.toggle('active', !locked && free === 'camera');
  pmHorizontal.classList.toggle('active', !locked && free === 'horizontal');

  // 锁定源按钮：按 source 高亮
  pmGround.classList.toggle('active', locked && lockedPlaneInfo && lockedPlaneInfo.source === 'ground');
  // 3点定面是瞬时动作，仅在拾取过程中高亮
  pm3Point.classList.toggle('active', planePickMode);
}

/** 设置自由绘制投影面模式（'camera' | 'horizontal'），并解锁任何锁定平面 */
function setFreePlaneMode(mode) {
  clearPolygonSelection();           // 解除任何锁定平面
  drawingController.setFreePlaneMode(mode);
  updatePlaneModeBarUI();
}

/** 锁定到地面网格平面 (XZ, y=-3) */
function lockGroundPlane() {
  if (!isEditMode) return;
  exitPlanePickModeSilent();
  clearPolygonSelection();
  hidePlaneBar();
  const groundY = -3; // 与 SceneSetup 网格高度一致
  // Plane(normal, constant)，constant = -normal·point = -(0,1,0)·(0,-3,0) = 3
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY);
  drawingController.setLockedPlane(plane);
  lockedPlaneInfo = {
    normal: new THREE.Vector3(0, 1, 0),
    center: new THREE.Vector3(0, groundY, 0),
    source: 'ground',
  };
  updatePlaneIndicator();
  updatePlaneModeBarUI();
  setToolLabel('已锁定地面平面 (y=-3) - 在地面上绘制');
}

/* ---- 3 点定任意平面 ---- */

/** 进入 3 点拾取模式 */
function enterPlanePickMode() {
  if (!isEditMode) return;
  clearPolygonSelection();
  hidePlaneBar();
  planePickMode = true;
  planePickPoints = [];
  canvas3D.style.cursor = 'crosshair';
  updatePlaneModeBarUI();
  setToolLabel('3点定面: 依次点击 3 个端点圆球定义平面（含倾斜面，Esc 取消）');
}

/** 退出 3 点拾取模式（用户取消） */
function exitPlanePickMode() {
  if (!planePickMode) return;
  for (const p of planePickPoints) lineManager.setMultiSelectHighlight(p.mesh, false);
  planePickPoints = [];
  planePickMode = false;
  canvas3D.style.cursor = '';
  updatePlaneModeBarUI();
  setToolLabel('');
}

/** 静默退出拾取模式（不重置提示，用于切换到其他平面时清理） */
function exitPlanePickModeSilent() {
  if (!planePickMode) return;
  for (const p of planePickPoints) lineManager.setMultiSelectHighlight(p.mesh, false);
  planePickPoints = [];
  planePickMode = false;
  canvas3D.style.cursor = '';
}

/** 3 点收集完成：计算平面并锁定 */
function complete3PointPlane() {
  const [a, b, c] = planePickPoints.map(p => p.position);
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const normal = new THREE.Vector3().crossVectors(ab, ac);
  if (normal.length() < 0.0001) {
    setStatus('三点共线，无法定义平面 - 请重新选择第 3 个点');
    const last = planePickPoints.pop();
    lineManager.setMultiSelectHighlight(last.mesh, false);
    return;
  }
  normal.normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a);
  const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);

  // 清理高亮与拾取状态
  for (const p of planePickPoints) lineManager.setMultiSelectHighlight(p.mesh, false);
  planePickPoints = [];
  planePickMode = false;
  canvas3D.style.cursor = '';

  clearPolygonSelection(); // 先清掉旧锁定
  drawingController.setLockedPlane(plane);
  lockedPlaneInfo = { normal: normal.clone(), center, source: '3point' };
  updatePlaneIndicator();
  updatePlaneModeBarUI();
  setToolLabel('已锁定平面 (3点定义) - 后续绘制均在此平面');
}

/* ---- 平面模式栏按钮接线 ---- */
pmCamera.addEventListener('click', () => {
  setFreePlaneMode('camera');
  setToolLabel('自由绘制 - 镜头面（笔触正对相机）');
});
pmHorizontal.addEventListener('click', () => {
  setFreePlaneMode('horizontal');
  setToolLabel('自由绘制 - 水平面（真实3D水平笔触，旋转相机可在不同高度叠层）');
});
pmGround.addEventListener('click', () => lockGroundPlane());
pm3Point.addEventListener('click', () => {
  if (planePickMode) exitPlanePickMode();
  else enterPlanePickMode();
});
pmUnlock.addEventListener('click', () => {
  exitPlanePickModeSilent();
  clearPolygonSelection();
  setToolLabel('已解除平面锁定 - 恢复自由绘制');
});

/* ---- 相机平滑过渡 ---- */
let camTween = null;
controls.addEventListener('start', () => { camTween = null; });

/* ================================================================
 *  Y 轴 hover 检测（纯数学，任意角度可靠）
 * ================================================================ */
const Y_HOVER_THRESHOLD = 0.05;
const Y_AXIS_LENGTH     = 10;
let   yAxisHovered      = false;
const _yRaycaster       = new THREE.Raycaster();
const _yMouse           = new THREE.Vector2();

function computeYAxisProximity(mouseNDC) {
  _yRaycaster.setFromCamera(mouseNDC, camera);
  const O = _yRaycaster.ray.origin;
  const v = _yRaycaster.ray.direction.clone().normalize();

  const vLateral = Math.sqrt(v.x * v.x + v.z * v.z);

  if (vLateral < 0.0001) {
    const distXZ = Math.sqrt(O.x * O.x + O.z * O.z);
    if (distXZ < Y_HOVER_THRESHOLD && Math.abs(O.y) <= Y_AXIS_LENGTH + 1) {
      const clampedY = Math.max(-Y_AXIS_LENGTH, Math.min(Y_AXIS_LENGTH, O.y));
      return { point: new THREE.Vector3(0, clampedY, 0), dist: distXZ };
    }
    return null;
  }

  const crossVU_x = v.z;
  const crossVU_z = -v.x;
  const dist = Math.abs(crossVU_x * O.x + crossVU_z * O.z) / vLateral;

  if (dist > Y_HOVER_THRESHOLD) return null;

  const dotVU = v.y;
  const dotOU = O.y;
  const t = (dotOU * dotVU - O.dot(v)) / (1 - dotVU * dotVU);
  const s = dotOU + t * dotVU;

  if (Math.abs(s) > Y_AXIS_LENGTH + 0.5) return null;

  const clampedS = Math.max(-Y_AXIS_LENGTH, Math.min(Y_AXIS_LENGTH, s));
  return { point: new THREE.Vector3(0, clampedS, 0), dist };
}

function setYAxisVisual(on) {
  yAxisHoverMesh.visible = on;
  canvas3D.style.cursor = on ? 'crosshair' : '';
}

renderer.domElement.addEventListener('pointermove', (e) => {
  // 预览模式不显示 Y 轴 hover
  if (!isEditMode) {
    if (yAxisHovered) { yAxisHovered = false; setYAxisVisual(false); }
    hintCoordsEl.textContent = '坐标: (0,0,0)';
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  _yMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _yMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const result = computeYAxisProximity(_yMouse);
  const onAxis = result !== null;

  if (onAxis !== yAxisHovered) {
    yAxisHovered = onAxis;
    setYAxisVisual(onAxis);
  }

  if (result) {
    hintCoordsEl.textContent = `Y\u8f74: (0,${result.point.y.toFixed(2)},0) | \u53f3\u952e\u751f\u6210\u8f85\u52a9\u591a\u8fb9\u5f62`;
  } else {
    hintCoordsEl.textContent = '\u5750\u6807: (0,0,0)';
  }
});

/* ================================================================
 *  右击 Y 轴 → 弹出多边形弹窗（半径 + 边数）
 * ================================================================ */
const polygonModal    = document.getElementById('polygonModal');
const polygonRadiusIn = document.getElementById('polygonRadius');
const polygonSidesIn  = document.getElementById('polygonSides');
const polyConfirm     = document.getElementById('polygonConfirm');
const polyCancel      = document.getElementById('polygonCancel');
let   pendingPolygonY = null;

renderer.domElement.addEventListener('contextmenu', (e) => {
  if (!isEditMode) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  // ★ 右键命中独立圆点/圆球 → 删除（带撤销）
  focusRaycaster.setFromCamera(new THREE.Vector2(mx, my), camera);
  const epMeshes = lineManager.getEndpointMeshes();
  const hits = focusRaycaster.intersectObjects(epMeshes, false);
  if (hits.length > 0) {
    const hitMesh = hits[0].object;
    const key = hitMesh.userData.endpointKey;
    const isFree = freeSpheres.some(s => s.key === key);
    if (isFree) {
      e.preventDefault();
      e.stopPropagation();
      deleteFreeSphereWithHistory(key);
      setStatus('已删除圆点/圆球');
      return;
    }
  }

  // 原有逻辑：右键 Y 轴 → 多边形弹窗
  if (!yAxisHovered) return;
  e.preventDefault();
  e.stopPropagation();

  _yMouse.x = mx;
  _yMouse.y = my;

  const result = computeYAxisProximity(_yMouse);
  if (!result) return;

  pendingPolygonY = result.point.y;
  polygonRadiusIn.value = 1;
  polygonSidesIn.value  = 4;
  polygonModal.style.display = 'flex';
  polygonRadiusIn.focus();
});

polyConfirm.addEventListener('click', () => {
  if (pendingPolygonY === null) return;
  const radius = parseFloat(polygonRadiusIn.value) || 1;
  const sides  = parseInt(polygonSidesIn.value, 10) || 4;
  addPolygonWithHistory(pendingPolygonY, radius, sides);
  pendingPolygonY = null;
  polygonModal.style.display = 'none';
});

polyCancel.addEventListener('click', () => {
  pendingPolygonY = null;
  polygonModal.style.display = 'none';
});

// 键盘操作
polygonModal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    polyConfirm.click();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    polyCancel.click();
  }
});

// 点击遮罩关闭
polygonModal.addEventListener('click', (e) => {
  if (e.target === polygonModal) polyCancel.click();
});

/* ================================================================
 *  双击端点 → 聚焦
 * ================================================================ */
let focusTarget = null;
let focusedMesh = null;
const FOCUS_COLOR = 0xffcc00;

let _dblClickLastTime = 0;
let _dblClickLastMesh = null;
let _dblClickLastYTime = 0;
let _dblClickLastBlankTime = 0;
let _dblClickLastBlankX = 0;
let _dblClickLastBlankY = 0;
const _DBL_CLICK_THRESHOLD = 350;
const focusRaycaster = new THREE.Raycaster();

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );

  // --- 3点定面模式：拦截普通点击，收集端点 ---
  // ★ Ctrl+click 例外：不拦截，放行给 DrawingController 做多选上色
  if (planePickMode && !e.ctrlKey) {
    focusRaycaster.setFromCamera(mouse, camera);
    const meshes = lineManager.getEndpointMeshes();
    const hits = meshes.length ? focusRaycaster.intersectObjects(meshes, false) : [];
    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      if (!planePickPoints.some(p => p.mesh === hitMesh)) {
        planePickPoints.push({ mesh: hitMesh, position: hitMesh.position.clone() });
        lineManager.setMultiSelectHighlight(hitMesh, true);
        if (planePickPoints.length === 3) {
          complete3PointPlane();
        } else {
          setStatus(`3点定面: 已选 ${planePickPoints.length}/3 点`);
        }
      }
    }
    e.stopPropagation();
    e.preventDefault();
    return;
  }

  // --- Alt+拖拽圆点/圆球：移动端点，连线跟随 ---
  if (e.altKey) {
    focusRaycaster.setFromCamera(mouse, camera);
    const meshes = lineManager.getEndpointMeshes();
    const hits = meshes.length ? focusRaycaster.intersectObjects(meshes, false) : [];
    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      const key = hitMesh.userData.endpointKey;
      if (key) {
        e.stopPropagation();
        e.preventDefault();
        startEndpointDrag(key, hitMesh, mouse);
        return;
      }
    }
  }

  // --- Y 轴左键：双击生成圆球 / 单击从交点开始画线 ---
  // 注意：直接重新计算 Y 轴邻近，而不是依赖 yAxisHovered 标志，
  // 否则第一次单击已把 yAxisHovered 置为 false，第二次单击会漏判双击。
  const yProx = computeYAxisProximity(mouse);
  if (yProx) {
    const now = performance.now();
    // 双击 Y 轴 → 在该点生成独立圆球（不再触发从 Y 轴画线）
    if (now - _dblClickLastYTime < _DBL_CLICK_THRESHOLD) {
      e.stopPropagation();
      e.preventDefault();
      yAxisHovered = false;
      setYAxisVisual(false);
      createFreeSphere(yProx.point);
      _dblClickLastYTime = 0;
      return;
    }
    _dblClickLastYTime = now;
    yAxisHovered = false;
    setYAxisVisual(false);
    drawingController.setSnapStartPoint(yProx.point);
    setToolLabel('\u4ece Y\u8f74\u5f00\u59cb\u753b\u7ebf');
    return;
  }

  // --- 双击端点聚焦 ---
  focusRaycaster.setFromCamera(mouse, camera);
  const meshes = lineManager.getEndpointMeshes();
  const intersects = focusRaycaster.intersectObjects(meshes, false);

  if (intersects.length === 0) {
    // ★ 空白区域双击：生成圆点 / Shift+双击：生成圆球
    const now2 = performance.now();
    const dx = e.clientX - _dblClickLastBlankX;
    const dy = e.clientY - _dblClickLastBlankY;
    const isDbl = (now2 - _dblClickLastBlankTime) < _DBL_CLICK_THRESHOLD && (dx * dx + dy * dy) < 100;
    if (isDbl) {
      const pos = computeBlankPoint(mouse);
      if (pos) {
        if (e.shiftKey) createFreeBall(pos);
        else createFreeDot(pos);
      }
      e.stopPropagation();
      e.preventDefault();
      _dblClickLastBlankTime = 0;
      return;
    }
    _dblClickLastBlankTime = now2;
    _dblClickLastBlankX = e.clientX;
    _dblClickLastBlankY = e.clientY;
    _dblClickLastMesh = null;
    _dblClickLastTime = 0;
    return;
  }

  const hitMesh = intersects[0].object;
  const now = performance.now();

  if (hitMesh === _dblClickLastMesh && (now - _dblClickLastTime) < _DBL_CLICK_THRESHOLD) {
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (focusedMesh && focusedMesh !== hitMesh) {
      focusedMesh.material.color.set(focusedMesh.userData._originalColor ?? 0x6366f1);
      focusedMesh.material.opacity = 0.6;
    }

    if (!hitMesh.userData._originalColor) {
      hitMesh.userData._originalColor = hitMesh.material.color.getHex();
    }

    hitMesh.material.color.set(FOCUS_COLOR);
    hitMesh.material.opacity = 0.95;

    focusedMesh = hitMesh;
    focusTarget = hitMesh.position.clone();
    setToolLabel('\u5df2\u805a\u7126\u5230\u7aef\u70b9');

    _dblClickLastMesh = null;
    _dblClickLastTime = 0;
  } else {
    _dblClickLastMesh = hitMesh;
    _dblClickLastTime = now;
  }
}, { capture: true });

/* ================================================================
 *  动画循环
 * ================================================================ */
function animate() {
  requestAnimationFrame(animate);

  if (focusTarget) {
    controls.target.lerp(focusTarget, 0.3);  // ★ 快速聚焦
    if (controls.target.distanceTo(focusTarget) < 0.001) {
      controls.target.copy(focusTarget);
    }
  }

  // 相机平滑过渡到目标平面视角
  if (camTween) {
    camera.position.lerp(camTween.posTo, 0.15);
    controls.target.lerp(camTween.targetTo, 0.15);
    if (camera.position.distanceTo(camTween.posTo) < 0.05 &&
        controls.target.distanceTo(camTween.targetTo) < 0.05) {
      camera.position.copy(camTween.posTo);
      controls.target.copy(camTween.targetTo);
      camTween = null;
    }
  }

  controls.update();

  // 笔刷粒子更新（淡出 + 朝向相机）
  brushManager.update();

  renderer.render(scene, camera);
}
animate();

/* ================================================================
 *  键盘快捷键（功能 5）：1/2/3 模式、E/P 编辑预览、Esc 取消、Ctrl+Z/Y 撤销重做、Delete 删除
 * ================================================================ */
window.addEventListener('keydown', (e) => {
  // 弹窗 / 输入框中不触发
  if (polygonModal.style.display === 'flex') return;
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  if (typing) return;

  const k = e.key.toLowerCase();

  // 撤销 / 重做
  if (e.ctrlKey || e.metaKey) {
    if (k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (k === 'y') { e.preventDefault(); doRedo(); return; }
    return;
  }

  // 绘制模式：1 随手画 / 2 直线 / 3 曲线
  if (e.key === '1') { setActiveDrawMode('freehand'); return; }
  if (e.key === '2') { setActiveDrawMode('straight');  return; }
  if (e.key === '3') { setActiveDrawMode('curve');     return; }

  // 编辑 / 预览切换
  if (k === 'e') { setEditMode(true);  return; }
  if (k === 'p') { setEditMode(false); return; }

  // Esc：取消当前绘制 / 清除选中 / 清除多选 / 解除平面锁定
  if (e.key === 'Escape') {
    // 优先退出 3 点拾取模式
    if (planePickMode) { exitPlanePickMode(); return; }
    if (drawingController.isDrawing()) drawingController.cancelCurrentDraw();
    clearLineSelection();
    clearMultiSelect();
    clearPolygonSelection();
    hidePlaneBar();
    setToolLabel('');
    return;
  }

  // Delete / Backspace：删除选中线条 → 选中多边形 → 否则清空所有（可撤销）
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); // 防止 Backspace 触发浏览器后退
    if (!isEditMode) return;
    if (selectedLineId) { deleteSingleLine(selectedLineId); setStatus('已删除选中线条'); return; }
    if (activePolygon)  { removePolygonWithHistory(activePolygon); setStatus('已删除选中辅助多边形'); return; }
    // 无选中线条 → 删除所有着色面
    if (coloredFaces.length > 0) {
      const count = coloredFaces.length;
      removeAllColoredFaces();
      setStatus(`已清除 ${count} 个着色面`);
      return;
    }
    if (polygonGroups.length > 0) {
      if (confirm('确定清空所有辅助多边形？此操作可用 Ctrl+Z 撤销')) {
        clearAllPolygonsWithHistory();
        setStatus('已清空所有辅助多边形');
      }
    }
  }
});

window.__lineManager    = lineManager;
window.__removePolygons = removeAllPolygons;