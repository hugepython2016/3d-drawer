import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * SceneSetup - 场景初始化
 */
export function createScene(canvas) {
  // === 渲染器 ===
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0xf5f0e8, 1);
  renderer.shadowMap.enabled = false;

  // === 场景 ===
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xf5f0e8, 20, 80);

  // === 相机 ===
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(8, 6, 10);
  camera.lookAt(0, 0, 0);

  // === OrbitControls ===
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
  controls.minDistance = 2;
  controls.maxDistance = 50;
  controls.target.set(0, 0, 0);
  controls.update();

  // === 灯光 ===
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(10, 20, 10);
  scene.add(dirLight);

  // === 辅助图层分组（编辑模式显示，预览模式整体隐藏） ===
  const helperGroup = new THREE.Group();
  helperGroup.name = 'helperGroup';
  scene.add(helperGroup);

  // === 地面网格 ===
  const gridHelper = new THREE.GridHelper(20, 20, 0xcccccc, 0xdddddd);
  gridHelper.position.y = -3;
  helperGroup.add(gridHelper);

  // === 坐标轴细线 ===
  const axesLength = 10;
  const makeAxisLine = (a, b, color) => {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3, depthTest: true });
    helperGroup.add(new THREE.Line(g, m));
  };
  makeAxisLine(new THREE.Vector3(-axesLength, 0, 0), new THREE.Vector3(axesLength, 0, 0), 0xff4444); // X 红
  makeAxisLine(new THREE.Vector3(0, -axesLength, 0), new THREE.Vector3(0, axesLength, 0), 0x44ff44); // Y 绿
  makeAxisLine(new THREE.Vector3(0, 0, -axesLength), new THREE.Vector3(0, 0, axesLength), 0x4444ff); // Z 蓝

  // === 原点 ===
  const origin = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  helperGroup.add(origin);

  // === Y 轴 hover 柱体（仅视觉反馈，检测用纯数学） ===
  const axisLen = axesLength * 2; // 总长 20
  const hoverRadius = 0.05;       // ★ 5倍原线条粗细，精致不笨重
  const hoverCylSegs = 16;

  const yHoverGeom = new THREE.CylinderGeometry(hoverRadius, hoverRadius, axisLen, hoverCylSegs, 1);
  const yHoverMat = new THREE.MeshBasicMaterial({
    color: 0x66ff66,
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false,
  });
  const yAxisHoverMesh = new THREE.Mesh(yHoverGeom, yHoverMat);
  yAxisHoverMesh.renderOrder = 999;
  yAxisHoverMesh.visible = false;
  helperGroup.add(yAxisHoverMesh);

  return { renderer, scene, camera, controls, yAxisHoverMesh, helperGroup };
}