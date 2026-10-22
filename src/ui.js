/** 控制面板：配置驱动生成滑块 / 开关 / 颜色 / 按钮 */

/** 支持 'lights.0.intensity' 这种路径 key */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}
function setPath(obj, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const t = ks.reduce((o, k) => o[k], obj);
  t[last] = v;
}

export const GROUPS = [
  {
    id: 'wind', title: '风', open: true,
    items: [
      { key: 'windDirection', label: '风向', min: 0, max: 360, step: 1, unit: '°', tag: 'wave' },
      { key: 'windStrength', label: '风力', min: 0, max: 12, step: 0.1, unit: '', tag: 'audio' },
      { key: 'windGust', label: '阵风扰动', min: 0, max: 1, step: 0.01, tag: '' },
    ],
  },
  {
    id: 'wave', title: '浪', open: true,
    items: [
      { key: 'waveHeight', label: '浪高', min: 0, max: 1.2, step: 0.01, unit: ' m', tag: 'wave' },
      { key: 'wavelength', label: '波长', min: 2, max: 20, step: 0.1, unit: ' m', tag: 'wave' },
      { key: 'waveSpeed', label: '浪速', min: 0.2, max: 2.5, step: 0.01, unit: '×', tag: 'wave' },
      { key: 'choppiness', label: '细碎度', min: 0, max: 1, step: 0.01, tag: 'wave' },
      { key: 'waveSpread', label: '波向扩散', min: 5, max: 90, step: 1, unit: '°', tag: 'wave' },
    ],
  },
  {
    id: 'water', title: '水体', open: true,
    items: [
      { key: 'waterLevel', label: '水位', min: -1.2, max: 0.8, step: 0.01, unit: ' m', tag: 'water' },
      { key: 'waterColor', label: '水色', type: 'color', tag: 'water' },
      { key: 'waterOpacity', label: '透明度', min: 0.2, max: 1, step: 0.01, tag: 'water' },
      { key: 'waterRoughness', label: '水面粗糙度', min: 0, max: 0.5, step: 0.01, tag: 'water' },
      { key: 'foamAmount', label: '浪尖白沫', min: 0, max: 1, step: 0.01, tag: 'water' },
    ],
  },
  {
    id: 'body', title: '漂浮物', open: false,
    items: [
      { key: 'density', label: '密度（相对水）', min: 0.1, max: 1.2, step: 0.01, tag: 'density' },
      { key: 'restitution', label: '弹性', min: 0, max: 0.9, step: 0.01, tag: 'physics' },
      { key: 'friction', label: '摩擦', min: 0, max: 1, step: 0.01, tag: 'physics' },
      { key: 'waterDrag', label: '水阻力', min: 0.1, max: 3, step: 0.01, tag: 'physics' },
      { key: 'angularDamping', label: '旋转阻尼', min: 0, max: 0.9, step: 0.01, tag: 'physics' },
      { key: 'objectScale', label: '导入尺寸', min: 0.3, max: 4, step: 0.05, unit: ' m', tag: '' },
    ],
  },
  {
    id: 'light', title: '光影', open: false,
    items: [
      { key: 'sunAzimuth', label: '太阳方位', min: 0, max: 360, step: 1, unit: '°', tag: 'sun' },
      { key: 'sunElevation', label: '太阳高度', min: 2, max: 85, step: 0.5, unit: '°', tag: 'sun' },
      { key: 'exposure', label: '曝光', min: 0.3, max: 2, step: 0.01, tag: 'render' },
      { key: 'shadows', label: '太阳阴影', type: 'toggle', tag: 'render' },
      { key: 'bloom', label: '辉光', type: 'toggle', tag: 'render' },
      { key: 'bloomStrength', label: '辉光强度', min: 0, max: 1, step: 0.01, tag: 'render' },
      { key: 'preset.dusk', label: '黄昏场景（突出灯光）', type: 'button', action: 'dusk' },
      { key: 'preset.day', label: '恢复白天', type: 'button', action: 'day' },
    ],
  },
  {
    id: 'sound', title: '声音', open: false,
    items: [
      { key: 'soundOn', label: '开启声音', type: 'toggle', tag: 'audio' },
      { key: 'masterVolume', label: '总音量', min: 0, max: 1, step: 0.01, tag: 'audio' },
      { key: 'waveVolume', label: '海浪声', min: 0, max: 1, step: 0.01, tag: 'audio' },
      { key: 'windVolume', label: '风声', min: 0, max: 1, step: 0.01, tag: 'audio' },
      { key: 'impactVolume', label: '碰撞声', min: 0, max: 1, step: 0.01, tag: 'audio' },
    ],
  },
];

// 三盏舞台灯：每盏一组独立控制
for (let i = 0; i < 3; i++) {
  GROUPS.push({
    id: 'stage' + i,
    title: '灯光 ' + (i + 1),
    open: false,
    items: [
      { key: `lights.${i}.on`, label: '开启', type: 'toggle', tag: 'lights' },
      { key: `lights.${i}.intensity`, label: '亮度', min: 0, max: 500, step: 5, tag: 'lights' },
      { key: `lights.${i}.color`, label: '颜色', type: 'color', tag: 'lights' },
      { key: `lights.${i}.azimuth`, label: '方位', min: 0, max: 360, step: 1, unit: '°', tag: 'lights' },
      { key: `lights.${i}.radius`, label: '距池心', min: 2, max: 18, step: 0.1, unit: ' m', tag: 'lights' },
      { key: `lights.${i}.height`, label: '高度', min: 0.2, max: 10, step: 0.1, unit: ' m', tag: 'lights' },
      { key: `lights.${i}.shadows`, label: '投射阴影', type: 'toggle', tag: 'lights' },
    ],
  });
}

export function createUI({ params, host, onChange, onAction }) {
  const controls = [];
  host.innerHTML = '';

  for (const g of GROUPS) {
    const sec = document.createElement('section');
    sec.className = 'group' + (g.open ? ' open' : '');
    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<span class="chev">▸</span><span>${g.title}</span>`;
    head.onclick = () => sec.classList.toggle('open');
    sec.appendChild(head);

    const body = document.createElement('div');
    body.className = 'group-body';

    for (const item of g.items) {
      const row = document.createElement('div');
      row.className = 'row';

      if (item.type === 'toggle') {
        row.classList.add('row-inline');
        const lab = document.createElement('label');
        lab.className = 'lab';
        lab.textContent = item.label;
        const sw = document.createElement('label');
        sw.className = 'switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!getPath(params, item.key);
        const knob = document.createElement('span');
        knob.className = 'knob';
        sw.append(cb, knob);
        cb.oninput = () => { setPath(params, item.key, cb.checked); onChange(item.key, cb.checked, item.tag); };
        row.append(lab, sw);
        controls.push({ key: item.key, set: (v) => { cb.checked = !!v; } });

      } else if (item.type === 'color') {
        row.classList.add('row-inline');
        const lab = document.createElement('label');
        lab.className = 'lab';
        lab.textContent = item.label;
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = getPath(params, item.key);
        inp.className = 'colorbox';
        inp.oninput = () => { setPath(params, item.key, inp.value); onChange(item.key, inp.value, item.tag); };
        row.append(lab, inp);
        controls.push({ key: item.key, set: (v) => { inp.value = v; } });

      } else if (item.type === 'button') {
        const b = document.createElement('button');
        b.className = 'wide';
        b.textContent = item.label;
        b.onclick = () => onChange(item.key, null, 'action', item.action);
        row.append(b);
        controls.push({ key: item.key, set: () => {} });

      } else {
        const lab = document.createElement('label');
        lab.className = 'lab-line';
        const val = document.createElement('span');
        val.className = 'val';
        const fmt = (v) => (item.step < 1 ? Number(v).toFixed(2) : Math.round(v)) + (item.unit || '');
        val.textContent = fmt(getPath(params, item.key));
        lab.innerHTML = `<span>${item.label}</span>`;
        lab.append(val);
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = item.min; inp.max = item.max; inp.step = item.step;
        inp.value = getPath(params, item.key);
        inp.oninput = () => {
          const v = parseFloat(inp.value);
          setPath(params, item.key, v);
          val.textContent = fmt(v);
          onChange(item.key, v, item.tag);
        };
        row.append(lab, inp);
        controls.push({
          key: item.key,
          set: (v) => { inp.value = v; val.textContent = fmt(v); },
        });
      }
      body.appendChild(row);
    }
    sec.appendChild(body);
    host.appendChild(sec);
  }

  return {
    refresh() { for (const c of controls) c.set(getPath(params, c.key)); },
    set(key, v) { const c = controls.find((x) => x.key === key); if (c) c.set(v); },
    onAction,
  };
}
