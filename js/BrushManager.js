import * as THREE from 'three';

/**
 * BrushManager - 墨迹笔刷系统
 *
 * 在 3D 平面上生成半透明墨迹粒子（Sprite），
 * 参考 folder 1 中的墨迹笔刷效果，支持在任意锁定平面上绘制。
 */

/** 生成径向渐变的圆形贴图 */
function createInkTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0,    'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(0.5,  'rgba(255,255,255,0.25)');
  gradient.addColorStop(0.75, 'rgba(255,255,255,0.05)');
  gradient.addColorStop(1,    'rgba(255,255,255,0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.premultiplyAlpha = true;
  return tex;
}

export class BrushManager {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    /** @type {{sprite:THREE.Sprite, life:number, maxLife:number}[]} */
    this.particles = [];
    this._maxParticles = 3000;

    // 共享贴图
    this._texture = createInkTexture();

    // 颜色 -> 材质 缓存
    /** @type {Map<number, THREE.SpriteMaterial>} */
    this._materials = new Map();
  }

  /** 获取或创建特定颜色的材质 */
  _getMaterial(colorHex) {
    let mat = this._materials.get(colorHex);
    if (mat) return mat;
    mat = new THREE.SpriteMaterial({
      map: this._texture,
      color: colorHex,
      transparent: true,
      opacity: 0.8,
      blending: THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
      premultipliedAlpha: true,
    });
    this._materials.set(colorHex, mat);
    return mat;
  }

  /**
   * 在 3D 坐标处生成一颗墨迹粒子
   * @param {THREE.Vector3} position
   * @param {number} colorHex
   * @param {number} [size=0.12]
   */
  spawnParticle(position, colorHex, size = 0.12) {
    this._cleanup();

    const mat = this._getMaterial(colorHex);
    const matClone = mat.clone();
    matClone.opacity = 0.8;

    const sprite = new THREE.Sprite(matClone);
    sprite.position.copy(position);
    sprite.scale.set(size, size, 1);
    sprite.renderOrder = 2;
    this.scene.add(sprite);

    this.particles.push({
      sprite,
      life: 0,
      maxLife: 45 + Math.random() * 35,
    });

    while (this.particles.length > this._maxParticles) {
      const old = this.particles.shift();
      this.scene.remove(old.sprite);
      old.sprite.material.dispose();
    }
  }

  /**
   * 在 position 附近生成一簇粒子（模拟笔刷触感）
   * @param {THREE.Vector3} position
   * @param {number} colorHex
   * @param {number} [count=3]
   */
  spawnBurst(position, colorHex, count = 3) {
    for (let i = 0; i < count; i++) {
      const r = (Math.random() - 0.5) * 0.08;
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * r * 2,
        (Math.random() - 0.5) * r * 2,
        (Math.random() - 0.5) * r * 2
      );
      const sz = 0.08 + Math.random() * 0.14;
      this.spawnParticle(position.clone().add(offset), colorHex, sz);
    }
  }

  /** 清理已死亡粒子 */
  _cleanup() {
    let i = this.particles.length;
    while (i--) {
      if (this.particles[i].life >= this.particles[i].maxLife) {
        const p = this.particles[i];
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
      }
    }
  }

  /** 每帧调用：淡出 + 粒子微调 */
  update() {
    this._cleanup();
    for (const p of this.particles) {
      p.life += 1;
      const t = p.life / p.maxLife;
      p.sprite.material.opacity = 0.8 * (1 - t * t);
      const s = p.sprite.scale.x;
      p.sprite.scale.set(s * 0.998, s * 0.998, 1);
    }
  }

  /** 清空所有粒子 */
  clear() {
    for (const p of this.particles) {
      this.scene.remove(p.sprite);
      p.sprite.material.dispose();
    }
    this.particles.length = 0;
  }

  /** 完全释放资源 */
  dispose() {
    this.clear();
    this._texture.dispose();
    for (const mat of this._materials.values()) mat.dispose();
    this._materials.clear();
  }
}
