import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { aimAtPerson, cloneConfig, Config, DEFAULT_CONFIG, distances, focalFromFov, layoutWarnings, optics, summary, validateConfig, withDistance } from './core';
import { Assessment, Simulation } from './scene';
import '@fontsource-variable/noto-sans-sc';
import './style.css';
import './fixes.css';

type Group = 'room' | 'person' | 'camera' | 'lens' | 'output' | 'distortion';
type NumericGroup = Exclude<Group, 'distortion'>;
const pretty = (v: number, n = 2) => Number.isFinite(v) ? v.toFixed(n) : '—';
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface FieldProps { label: string; unit?: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; help?: string; integer?: boolean; }
function Field({ label, unit, value, min, max, step, onChange, help, integer }: FieldProps) {
  const [text, setText] = useState(String(Number(value.toFixed(integer ? 0 : 3))));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!editing) setText(String(Number(value.toFixed(integer ? 0 : 3)))); }, [value, editing, integer]);
  function commit() {
    setEditing(false);
    const n = Number(text);
    if (!text.trim() || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      setError(`请输入 ${min}–${max} 范围内的${integer ? '整数' : '数字'}。`);
      setText(String(Number(value.toFixed(integer ? 0 : 3))));
      return;
    }
    setError('');
    onChange(n);
    setText(String(Number(value.toFixed(integer ? 0 : 3))));
  }
  return <label className="field">
    <span className="field-top"><span>{label}</span><span className="number-wrap"><input aria-label={label} type="number" min={min} max={max} step={step} value={text} onFocus={() => setEditing(true)} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /><small>{unit}</small></span></span>
    <input aria-label={`${label}滑块`} type="range" min={min} max={max} step={step} value={Math.max(min, Math.min(max, value))} onChange={e => { setError(''); onChange(Number(e.target.value)); }} />
    {error && <span className="field-error" role="alert">{error}</span>}
    {help && <span className="field-help">{help}</span>}
  </label>;
}

function App() {
  const [config, setConfig] = useState<Config>(() => cloneConfig(DEFAULT_CONFIG));
  const [message, setMessage] = useState('');
  const [model, setModel] = useState({ text: '正在初始化…', error: false });
  const [assessment, setAssessment] = useState<Assessment>({ framing: '等待人物加载', ratio: null, occlusion: '等待人物加载' });
  const [active, setActive] = useState<'room' | 'person' | 'camera' | 'lens' | 'output'>('room');
  const host = useRef<HTMLDivElement>(null), layout = useRef<HTMLDivElement>(null), cameraView = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [fieldRevision, setFieldRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const simulation = useRef<Simulation | null>(null), fileInput = useRef<HTMLInputElement>(null);
  const initial = useRef(config);
  const o = useMemo(() => optics(config), [config]);
  const d = useMemo(() => distances(config), [config]);
  const warnings = useMemo(() => layoutWarnings(config), [config]);
  const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);

  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(entries => {
      const r = entries[0].contentRect; setStageSize({ width: r.width, height: r.height });
    });
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!host.current || !layout.current || !cameraView.current) return;
    try {
      const instance = new Simulation(host.current, layout.current, cameraView.current, initial.current, {
        onAssessment: setAssessment, onModel: (text, error = false) => setModel({ text, error }),
      });
      simulation.current = instance;
      return () => { instance.dispose(); simulation.current = null; };
    } catch (e) { setModel({ text: `渲染初始化失败：${String(e)}。请检查 WebGL 2 是否可用。`, error: true }); }
  }, []);
  useEffect(() => { simulation.current?.update(config); }, [config]);

  function apply(next: Config) {
    const error = validateConfig(next);
    if (error) { setMessage(error); setFieldRevision(n => n + 1); return; }
    setMessage(''); setConfig(next);
  }
  function setNumber(group: NumericGroup, key: string, value: number) {
    const next = cloneConfig(config);
    (next[group] as unknown as Record<string, number>)[key] = value; apply(next);
  }
  function setDistortion(key: 'enabled' | 'k1', value: boolean | number) {
    const next = cloneConfig(config);
    if (key === 'enabled') next.distortion.enabled = value as boolean; else next.distortion.k1 = value as number;
    apply(next);
  }
  function fov(axis: 'h' | 'v', value: number) {
    const next = cloneConfig(config); next.lens.focalLength = focalFromFov(axis === 'h' ? o.width : o.height, value); apply(next);
  }
  function resetCamera() {
    const next = cloneConfig(config); next.camera = { ...DEFAULT_CONFIG.camera }; next.lens = { ...DEFAULT_CONFIG.lens }; next.distortion = { ...DEFAULT_CONFIG.distortion }; next.output = { ...DEFAULT_CONFIG.output }; apply(next);
  }
  async function loadFile(file: File) {
    try {
      if (file.size > 1024 * 1024) throw new Error('配置文件超过 1 MB。');
      const parsed: unknown = JSON.parse(await file.text());
      const error = validateConfig(parsed); if (error) throw new Error(error);
      apply(parsed as Config); setMessage('配置已加载。');
    } catch (e) { setMessage(`加载失败：${e instanceof Error ? e.message : String(e)}`); }
  }
  async function screenshot() {
    if (exporting) return;
    setExporting(true);
    try {
      if (!simulation.current || model.error || !model.text.includes('已就绪')) throw new Error('人物或渲染器尚未就绪。');
      const { width, height } = config.output;
      setMessage(`正在渲染 ${width} × ${height} PNG…`);
      // Let the status text paint before the synchronous high-resolution render.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      download(await simulation.current.screenshot(), '摄像机画面.png');
      setMessage(`PNG 截图已导出（${width} × ${height}）。`);
    } catch (e) { setMessage(`截图失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setExporting(false); }
  }
  const section = (name: typeof active, label: string, icon: string) => <button className={`tab ${active === name ? 'selected' : ''}`} onClick={() => setActive(name)}><span>{icon}</span>{label}</button>;
  const field = (group: NumericGroup, key: string, label: string, unit: string, min: number, max: number, step: number, help?: string, integer?: boolean) => <Field label={label} unit={unit} value={(config[group] as unknown as Record<string, number>)[key]} min={min} max={max} step={step} help={help} integer={integer} onChange={v => setNumber(group, key, v)} />;

  return <div className="app">
    <header className="header">
      <div className="brand"><div className="brand-icon">◉</div><div><b>镜界</b><span>摄像机效果仿真控制台</span></div></div>
      <div className="header-right"><span className="offline"><i />{localHost ? '本地离线运行' : '在线访问 · 无外部接口'}</span><button onClick={() => { apply(cloneConfig(DEFAULT_CONFIG)); simulation.current?.resetView(); }}>↺ <span>恢复默认</span></button></div>
    </header>
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-head"><div><span className="eyebrow">SIMULATION SETTINGS</span><h2>仿真参数</h2></div><span className="step-badge">实时同步</span></div>
        <nav className="tabs" aria-label="参数类别">{section('room', '会议室', '▦')}{section('person', '人物', '♙')}{section('camera', '摄像机', '◉')}{section('lens', '镜头成像', '◈')}{section('output', '输出', '▣')}</nav>
        <div className="controls" key={`${active}-${fieldRevision}`}>
          {active === 'room' && <><div className="control-title"><h3>会议室尺寸</h3><p>调整房间大小，桌椅保持真实尺寸。</p></div>
            {field('room', 'length', '房间长度', 'm', 2, 12, 0.1)}{field('room', 'width', '房间宽度', 'm', 2, 10, 0.1)}{field('room', 'height', '房间高度', 'm', 2, 5, 0.1)}
            <div className="note"><b>自动布局</b> 桌子固定为 2.2 × 1.2 m，四把椅子固定排列。房间过小或发生越界时仅提示，不拉伸家具。</div>
          </>}
          {active === 'person' && <><div className="control-title"><h3>人物设置</h3><p>等比例缩放，始终在水平面内面向摄像机。</p></div>
            {field('person', 'height', '人物身高', 'm', 1.2, 2.2, 0.01)}
            <Field label="人物水平距离" unit="m" value={d.horizontal} min={0.2} max={20} step={0.05} onChange={v => apply(withDistance(config, v))} help="相机地面投影到人物地面参考点；沿当前连线移动人物。" />
            {field('person', 'x', '人物位置 X', 'm', -20, 20, 0.05)}{field('person', 'z', '人物位置 Z', 'm', -20, 20, 0.05)}
            <div className="note"><b>三维直线距离 {pretty(d.spatial)} m</b><br />从摄像机光心到人物身高中点。家具可能遮挡人物，不会强制全身入画。</div>
          </>}
          {active === 'camera' && <><div className="control-title"><h3>摄像机位置与角度</h3><p>手动角度不会被自动对准覆盖。</p></div>
            {field('camera', 'x', '摄像机位置 X', 'm', -20, 20, 0.05)}{field('camera', 'z', '摄像机位置 Z', 'm', -20, 20, 0.05)}{field('camera', 'y', '安装高度 Y', 'm', 0.05, 10, 0.05)}
            {field('camera', 'yaw', '水平旋转角', '°', -180, 180, 1, '0° 指向 +Z，正角朝 +X。')}{field('camera', 'pitch', '俯仰角', '°', -89, 89, 1, '正值朝上；横滚固定 0°。')}
            <div className="button-row"><button className="outline-btn" onClick={() => { try { apply(aimAtPerson(config)); } catch (e) { setMessage((e as Error).message); } }}>◎ 对准人物</button><button className="outline-btn" onClick={resetCamera}>↺ 恢复相机</button></div>
          </>}
          {active === 'lens' && <><div className="control-title"><h3>镜头与成像</h3><p>输入有效成像区域与镜头实际焦距。</p></div>
            {field('lens', 'pixelSize', '像素大小', 'μm', 0.5, 10, 0.01)}
            {field('lens', 'sensorWidth', '有效成像像素宽', 'px', 256, 12000, 1, undefined, true)}{field('lens', 'sensorHeight', '有效成像像素高', 'px', 256, 12000, 1, undefined, true)}
            {field('lens', 'focalLength', '实际焦距', 'mm', 0.5, 50, 0.01, '不是 35 mm 等效焦距。')}
            <Field label="画面水平视场角" unit="°" value={o.hfov} min={1} max={169} step={0.1} onChange={v => fov('h', v)} />
            <Field label="画面垂直视场角" unit="°" value={o.vfov} min={1} max={169} step={0.1} onChange={v => fov('v', v)} />
            <div className="separator" /><div className="switch-row"><div><b>镜头畸变</b><small>简化径向模型，非实测标定</small></div><button role="switch" aria-label="镜头畸变" aria-checked={config.distortion.enabled} className={`switch ${config.distortion.enabled ? 'on' : ''}`} onClick={() => setDistortion('enabled', !config.distortion.enabled)}><span /></button></div>
            <Field label="径向畸变 k1" value={config.distortion.k1} min={-0.35} max={0.35} step={0.005} onChange={v => setDistortion('k1', v)} help="负值桶形，正值枕形；采样越界显示黑边。" />
          </>}
          {active === 'output' && <><div className="control-title"><h3>输出设置</h3><p>预览随窗口自适应；导出截图按下方分辨率单独离线渲染。</p></div>
            {field('output', 'width', '导出宽度', 'px', 256, 4096, 1, undefined, true)}{field('output', 'height', '导出高度', 'px', 256, 4096, 1, undefined, true)}
            <div className="presets"><span>导出分辨率</span><button onClick={() => { const n = cloneConfig(config); n.output = { width: 1920, height: 1080 }; apply(n); }}>1080P</button><button onClick={() => { const n = cloneConfig(config); n.output = { width: 3840, height: 2160 }; apply(n); }}>4K UHD</button><button onClick={() => { const n = cloneConfig(config); n.output = { width: 1600, height: 1200 }; apply(n); }}>4:3</button><button onClick={() => { const n = cloneConfig(config); n.output = { width: 1080, height: 1080 }; apply(n); }}>1:1</button></div>
            <div className="note"><b>预览与导出分离</b> 预览分辨率只影响实时画面；导出的 PNG 使用上方像素尺寸，不受窗口大小影响。4K 导出在集成显卡上可能需要数秒。<br /><br /><b>中心裁切</b> 输出比例不同时裁切有效成像区域，不拉伸画面；导出尺寸受 GPU 渲染缓冲上限限制。</div>
          </>}
        </div>
        <div className="sidebar-footer"><span className="dot" />参数修改即时生效 <span>v1.0</span></div>
      </aside>

      <div className="content">
        <div className="page-intro"><div><span className="eyebrow">CAMERA SIMULATION / WORKSPACE</span><h1>构想你的<span>理想画面</span></h1><p>调整空间与成像参数，即时预览镜头下的每一种可能。</p></div><div className="intro-stat"><span>当前场景</span><b>会议室 <em>01</em></b></div></div>
        <div className="view-grid" ref={host}>
          <section className="view-card"><div className="view-head"><div><span className="view-icon">▦</span><div><b>场景布局</b><small>SPACE OVERVIEW</small></div></div><button onClick={() => simulation.current?.resetView()} title="重置布局视角">⌖</button></div>
            <div className="view-surface layout-surface" ref={layout} aria-label="场景布局视图"><div className="view-overlay top-left"><span className="live-dot" />3D 空间</div><div className="view-overlay bottom-left">拖动旋转 <span>·</span> 滚轮缩放</div><div className="view-overlay bottom-right">{config.room.length} × {config.room.width} × {config.room.height} m</div></div>
            <div className="view-foot"><span><i className="legend-line" /> 无畸变视锥（显示至 5 m）</span><span>网格间距约 1 m</span></div>
          </section>
          <section className="view-card"><div className="view-head"><div><span className="view-icon">◉</span><div><b>摄像机画面</b><small>CAMERA PREVIEW</small></div></div><span className="live-label"><i /> LIVE</span></div>
            <div className="camera-stage" ref={stage}><div className="view-surface camera-surface" ref={cameraView} style={{ width: Math.min(stageSize.width, stageSize.height * o.aspect), height: Math.min(stageSize.height, stageSize.width / o.aspect) }} aria-label="摄像机画面视图"><div className="view-overlay top-left"><span className="rec-dot" /> CAM 01 · 预览</div><div className="view-overlay bottom-right">导出 {config.output.width} × {config.output.height}</div></div></div>
            <div className="view-foot"><span><i className="legend-circle" /> {config.distortion.enabled ? `畸变开启 · k1 ${config.distortion.k1}` : '无畸变透视'}</span><span>画面比例 {pretty(o.aspect, 2)}:1</span></div>
          </section>
        </div>

        <div className="analysis-head"><div><span className="eyebrow">SELECTION INSIGHTS</span><h2>画面分析 <span>实时计算</span></h2></div><small>理论值仅供初步选型参考</small></div>
        <div className="metric-grid">
          <div className="metric"><div className="metric-label">人物入画 <span>↗</span></div><strong className={assessment.framing.includes('完整') ? 'good' : ''}>{assessment.framing}</strong><small>{assessment.occlusion}</small></div>
          <div className="metric"><div className="metric-label">画内高度占比 <span>▥</span></div><strong>{assessment.ratio === null ? '—' : `${pretty(assessment.ratio * 100, 1)}%`}</strong><small>包围盒投影高度近似，非像素占比</small></div>
          <div className="metric"><div className="metric-label">水平视场角 <span>⌁</span></div><strong>{pretty(o.hfov, 1)}<em>°</em></strong><small>裁切后 · 无畸变理论值</small></div>
          <div className="metric"><div className="metric-label">垂直视场角 <span>⌁</span></div><strong>{pretty(o.vfov, 1)}<em>°</em></strong><small>裁切后 · 无畸变理论值</small></div>
        </div>
        <div className="details-grid">
          <section className="detail-card"><div className="detail-head"><h3>成像参数</h3><span>OPTICS</span></div><dl>
            <div><dt>实际焦距</dt><dd>{pretty(config.lens.focalLength)} mm</dd></div><div><dt>像素大小</dt><dd>{config.lens.pixelSize} μm</dd></div>
            <div><dt>有效成像像素</dt><dd>{config.lens.sensorWidth} × {config.lens.sensorHeight} px</dd></div><div><dt>有效成像尺寸</dt><dd>{pretty(o.sensorW)} × {pretty(o.sensorH)} mm</dd></div>
            <div><dt>裁切后成像尺寸</dt><dd>{pretty(o.width)} × {pretty(o.height)} mm</dd></div><div><dt>完整区域视场角 H / V</dt><dd>{pretty(o.fullHfov, 1)}° / {pretty(o.fullVfov, 1)}°</dd></div>
            <div><dt>输出分辨率 / 比例</dt><dd>{config.output.width} × {config.output.height} / {pretty(o.aspect)}:1</dd></div><div><dt>画面对角视场角</dt><dd>{pretty(o.dfov, 1)}°</dd></div>
          </dl></section>
          <section className="detail-card"><div className="detail-head"><h3>空间关系</h3><span>SPATIAL</span></div><dl>
            <div><dt>人物身高</dt><dd>{pretty(config.person.height)} m</dd></div><div><dt>人物位置 X / Z</dt><dd>{pretty(config.person.x)} / {pretty(config.person.z)} m</dd></div>
            <div><dt>水平距离</dt><dd>{pretty(d.horizontal)} m</dd></div><div><dt>到身高中点的三维距离</dt><dd>{pretty(d.spatial)} m</dd></div>
            <div><dt>相机位置 X / Y / Z</dt><dd>{pretty(config.camera.x)} / {pretty(config.camera.y)} / {pretty(config.camera.z)} m</dd></div><div><dt>水平 / 俯仰 / 横滚</dt><dd>{pretty(config.camera.yaw)}° / {pretty(config.camera.pitch)}° / 0°</dd></div>
            <div><dt>畸变</dt><dd>{config.distortion.enabled ? `径向 k1=${config.distortion.k1}` : '关闭'}</dd></div>
          </dl></section>
        </div>
        <div className="action-bar"><div><b>保存与分享</b><span>配置、截图及参数均保存在本地</span></div><div className="actions">
          <button onClick={() => download(new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }), '摄像机配置.json')}>↓ 保存配置</button>
          <button onClick={() => fileInput.current?.click()}>↑ 加载配置</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void loadFile(file); e.target.value = ''; }} />
          <button onClick={() => download(new Blob([summary(config, `${assessment.framing}；${assessment.occlusion}`)], { type: 'text/plain;charset=utf-8' }), '摄像机参数摘要.txt')}>≡ 参数摘要</button>
          <button className="primary" disabled={exporting} onClick={() => void screenshot()} title={`按 ${config.output.width} × ${config.output.height} 导出 PNG`}>{exporting ? '正在导出…' : '▣ 导出截图'}</button>
        </div></div>
        <div className="notices" aria-live="polite"><div className={model.error ? 'error' : ''}>{model.text}</div>{message && <div>{message}</div>}{warnings.map(w => <div className="warning" key={w}>⚠ {w}</div>)}<p>入画为保守包围盒判断，临界及畸变时可能不确定；占比不扣除遮挡。遮挡仅测试 4 个中心点，未发现遮挡不等于无遮挡。视锥不含畸变黑边。未模拟真实镜头标定、ISP、噪声、动态范围、景深及自动曝光/白平衡。</p></div>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
