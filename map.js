'use strict';
/* Cascade region map: Emerald-style presentation with normalised location and
 * map-preset metadata. Dimensions are always obtained from decoded images.
 * Emerald cursor: two 20-frame phases; movement is four GBA frames per step.
 */
(() => {
  const $ = id => document.getElementById(id);
  // Resolve assets relative to this script rather than the document's <base> URL.
  // index.html and map.js are installed in the same project directory.
  const dataRoot = new URL('.', document.currentScript?.src || document.URL);
  const el = {
    viewport: $('viewport'), scene: $('mapScene'), stage: $('stage'),
    terrain: $('terrainLayer'), routes: $('routesLayer'), towns: $('townsLayer'),
    cursorOverlay: $('cursorLayer'), cursor: $('cursor'),
    frames: [$('cursorFrame1'), $('cursorFrame2')],
    select: $('mapSelect'), name: $('locationName'), loading: $('loading'),
    error: $('mapError'), terrainMode: $('terrainMode'),
    routesMode: $('routesMode'), townsMode: $('townsMode')
  };
  const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
  const GBA_FPS = 16777216 / 280896;
  const MOVE_MS = 4000 / GBA_FPS;
  const FULL = {x: 0, y: 0, width: 1, height: 1};
  // Source pixels are never reduced or interpolated. Supported zooms are 1x...8x.
  const MAX_ZOOM = 8;
  const state = {
    width: 0, height: 0, scale: 1, tx: 0, ty: 0, wheelDelta: 0,
    x: 0, y: 0, bounds: FULL, preset: '',
    maps: [], locations: [], routes: true, towns: true,
    ready: false, pointers: new Map(), drag: null, pinch: null,
    held: new Set(), moving: null, raf: 0, cursorScale: null
  };

  function report(error) {
    console.error('Region map:', error);
    el.loading.hidden = true;
    el.error.hidden = false;
    el.error.textContent = 'Map metadata could not be loaded. Check the browser console for details.';
  }
  async function decode(img) {
    if (!img.complete) await new Promise((resolve, reject) => {
      img.addEventListener('load', resolve, {once: true});
      img.addEventListener('error', () => reject(new Error(`Image failed: ${img.src}`)), {once: true});
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error(`Image failed: ${img.src}`);
    if (typeof img.decode === 'function') await img.decode();
    return img;
  }
  function validRect(e) {
    return e && [e.x,e.y,e.width,e.height].every(n => typeof n === 'number' && Number.isFinite(n)) &&
      e.x >= 0 && e.y >= 0 && e.width > 0 && e.height > 0 &&
      e.x + e.width <= 1.00000001 && e.y + e.height <= 1.00000001;
  }
  function validateMaps(value) {
    if (!Array.isArray(value)) throw new Error('Map presets must be an array.');
    const ids = new Set();
    return value.map((e,i) => {
      if (!validRect(e) || typeof e.name !== 'string' || !e.name.trim()) {
        throw new Error(`Invalid map preset at index ${i}.`);
      }
      const id = (typeof e.id === 'string' && e.id.trim()) ? e.id.trim() : `preset-${i+1}`;
      if (ids.has(id)) throw new Error(`Duplicate map preset ID: ${id}`);
      ids.add(id);
      return {id, name: e.name.trim(), x:e.x,y:e.y,width:e.width,height:e.height};
    });
  }
  function validateLocations(value) {
    if (!Array.isArray(value)) throw new Error('Location areas must be an array.');
    for (const [i,e] of value.entries()) {
      if (!e || typeof e.name !== 'string') throw new Error(`Invalid location at index ${i}.`);
      if (e.type === 'rect' && !validRect(e)) throw new Error(`Invalid location rectangle at index ${i}.`);
      if (e.type === 'polygon' && (!Array.isArray(e.points) || e.points.length < 3 ||
        !e.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 1)))) {
        throw new Error(`Invalid location polygon at index ${i}.`);
      }
    }
    return value;
  }
  // JSON is canonical on HTTP(S). Local file pages use matching classic-script
  // snapshots exported by the editors, since fetch(file://...) is blocked.
  async function optionalJson(filename) {
    const url = new URL(filename, dataRoot);
    if (url.protocol === 'file:') return null;
    let response;
    try { response = await fetch(url, {cache: 'no-store'}); }
    catch (error) { throw new Error(`Unable to fetch ${filename}: ${error.message}`); }
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}`);
    try { return await response.json(); }
    catch (error) { throw new Error(`Invalid JSON in ${filename}: ${error.message}`); }
  }
  function metadataEntries(data, kind, filename) {
    const entries = Array.isArray(data) ? data : data?.[kind];
    if (!Array.isArray(entries)) {
      throw new Error(`${filename} must contain a ${kind} array.`);
    }
    return entries;
  }
  function optionalScript(filename) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let failure = null;
      const onError = event => {
        if (event.filename && event.filename.endsWith('/' + filename)) {
          failure = event.message || 'Script parsing failed';
        }
      };
      window.addEventListener('error', onError);
      const finish = loaded => {
        window.removeEventListener('error', onError);
        if (failure) reject(new Error(`${filename}: ${failure}`));
        else resolve(loaded);
      };
      script.src = new URL(filename, dataRoot).href;
      script.onload = () => finish(true);
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    });
  }
  async function snapshotEntries(kind) {
    const key = `CASCADE_${kind.toUpperCase()}`;
    const filename = `${kind}.local.js`;
    if (!await optionalScript(filename)) return null;
    const value = window[key];
    if (value === undefined || value === null)
      throw new Error(`${filename} did not set window.${key}.`);
    return {entries: metadataEntries(value, kind, filename), found: true};
  }
  async function legacyEntries(kind) {
    const key = `CASCADE_${kind.toUpperCase()}`;
    const scriptLoaded = await optionalScript(`${kind}.js`);
    const promise = window[`${key}_READY`];
    const value = promise ? await promise : window[key];
    if (value === undefined || value === null) return {entries: [], found: false};
    return {entries: metadataEntries(value, kind, `${kind}.js`), found: scriptLoaded};
  }
  async function loadMetadata() {
    const kinds = ['locations', 'maps'];
    const canonical = await Promise.all(kinds.map(async kind => {
      const filename = `${kind}.json`;
      if (dataRoot.protocol === 'file:') {
        const snapshot = await snapshotEntries(kind);
        if (snapshot) return snapshot;
        const legacy = await legacyEntries(kind);
        if (legacy.entries.length) return legacy;
        throw new Error(`Offline ${kind} metadata unavailable. Export from the ${kind === 'maps' ? 'MapTool' : 'Location Editor'} and extract ${kind}.local.js beside index.html.`);
      }
      const data = await optionalJson(filename);
      if (data !== null)
        return {entries: metadataEntries(data, kind, filename), found: true};
      const snapshot = await snapshotEntries(kind);
      return snapshot || legacyEntries(kind);
    }));
    let [locations, maps] = canonical.map(result => result.entries);


    {
      // Additional JSON files can be named explicitly in an optional manifest.
      // A static host cannot enumerate or discover arbitrary filenames.
      const manifest = await optionalJson('map-data.json');
      if (manifest !== null) {
        if (!manifest || !kinds.every(kind =>
          manifest[kind] === undefined || (Array.isArray(manifest[kind]) &&
          manifest[kind].every(path => typeof path === 'string' &&
          /^[\w./-]+\.json$/i.test(path) && !path.includes('..'))))) {
          throw new Error('Invalid map-data.json metadata manifest.');
        }
        for (const kind of kinds) {
          const paths = new Set(manifest[kind] || []);
          for (const path of paths) {
            if (path === `${kind}.json`) continue;
            const data = await optionalJson(path);
            if (data === null) continue;
            const entries = metadataEntries(data, kind, path);
            if (kind === 'locations') locations = locations.concat(entries);
            else maps = maps.concat(entries);
          }
        }
      }
    }
    state.locations = validateLocations(locations);
    state.maps = validateMaps(maps);
  }
  function inPolygon(x,y,points) {
    let inside = false;
    for (let i=0,j=points.length-1;i<points.length;j=i++) {
      const a = points[i], b = points[j];
      const cross = (x-a[0])*(b[1]-a[1]) - (y-a[1])*(b[0]-a[0]);
      if (Math.abs(cross)<1e-10 && x>=Math.min(a[0],b[0])-1e-10 && x<=Math.max(a[0],b[0])+1e-10 &&
          y>=Math.min(a[1],b[1])-1e-10 && y<=Math.max(a[1],b[1])+1e-10) return true;
      if ((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
    }
    return inside;
  }
  function locationAt(x,y) {
    const nx=x/state.width, ny=y/state.height;
    for(let i=state.locations.length-1;i>=0;i--) {
      const e=state.locations[i];
      if (e.type==='rect' && nx>=e.x && nx<=e.x+e.width && ny>=e.y && ny<=e.y+e.height) return e.name;
      if (e.type==='polygon' && inPolygon(nx,ny,e.points)) return e.name;
      if ((!e.type || e.type==='point') && Number.isFinite(e.x) && Number.isFinite(e.y) &&
          Math.hypot(nx-e.x,ny-e.y)<=(Number.isFinite(e.radius)?e.radius:0.012)) return e.name;
    }
    return 'POKéMON CASCADE';
  }
  function viewSize() { return {w: el.viewport.clientWidth, h: el.viewport.clientHeight}; }
  function rectPixels() {
    const b=state.bounds;
    // Metadata remains normalised, but visible boundaries lie on source pixel edges.
    return {left:Math.round(b.x*state.width),top:Math.round(b.y*state.height),
      right:Math.round((b.x+b.width)*state.width),bottom:Math.round((b.y+b.height)*state.height)};
  }
  function constrain() {
    const p=rectPixels(),v=viewSize(),s=state.scale;
    const w=(p.right-p.left)*s,h=(p.bottom-p.top)*s;
    state.tx=w<=v.w ? (v.w-(p.right+p.left)*s)/2 : clamp(state.tx,v.w-p.right*s,-p.left*s);
    state.ty=h<=v.h ? (v.h-(p.bottom+p.top)*s)/2 : clamp(state.ty,v.h-p.bottom*s,-p.top*s);
    // Integer CSS pixel translation avoids half-pixel interpolation on panning.
    state.tx=Math.round(state.tx);
    state.ty=Math.round(state.ty);
  }
  function mapToScreen(x,y) { return {x: state.tx+x*state.scale,y:state.ty+y*state.scale}; }
  function screenToMap(x,y) {
    const p=rectPixels();
    return {x:clamp((x-state.tx)/state.scale,p.left,p.right),y:clamp((y-state.ty)/state.scale,p.top,p.bottom)};
  }
  function render() {
    if (!state.ready) return;
    // The cursor remains outside the map layers to keep the artwork and
    // blink animation independent of stage clipping and image positioning.
    if (el.cursor.parentElement !== el.cursorOverlay) el.cursorOverlay.appendChild(el.cursor);
    // Neither CSS transforms nor fractional sizes are applied to the artwork.
    // At 1x, each source pixel occupies precisely one CSS pixel; higher integer
    // zooms replicate source pixels using image-rendering: pixelated.
    el.stage.style.left=`${state.tx}px`;
    el.stage.style.top=`${state.ty}px`;
    el.stage.style.width=`${state.width*state.scale}px`;
    el.stage.style.height=`${state.height*state.scale}px`;
    const p=rectPixels(),v=viewSize();
    const left=clamp(Math.round(p.left*state.scale+state.tx),0,v.w);
    const top=clamp(Math.round(p.top*state.scale+state.ty),0,v.h);
    const right=clamp(Math.round(p.right*state.scale+state.tx),0,v.w);
    const bottom=clamp(Math.round(p.bottom*state.scale+state.ty),0,v.h);
    const visibleClip = `inset(${top}px ${v.w-right}px ${v.h-bottom}px ${left}px)`;
    el.scene.style.clipPath=visibleClip;
    el.cursorOverlay.style.clipPath=visibleClip;
    // The sprite occupies the same map-space area at every zoom level.
    // Change its rendered dimensions instead of applying a CSS scale transform:
    // this keeps the artwork aligned to integer screen pixels and preserves
    // nearest-neighbour rendering. Frame dimensions come from the images.
    if (state.cursorScale !== state.scale) {
      for (const frame of el.frames) {
        frame.style.width = `${frame.naturalWidth * state.scale}px`;
        frame.style.height = `${frame.naturalHeight * state.scale}px`;
      }
      state.cursorScale = state.scale;
    }
    const cx=Math.round(state.tx+state.x*state.scale);
    const cy=Math.round(state.ty+state.y*state.scale);
    el.cursor.style.left=`${cx}px`;
    el.cursor.style.top=`${cy}px`;
    el.cursor.style.transform='none';
    el.cursor.style.visibility=cx>=left && cx<=right && cy>=top && cy<=bottom ? 'visible':'hidden';
    el.name.textContent=locationAt(state.x,state.y);
  }
  function fitView() {
    if (!state.ready) return;
    // Fitting an image wider than the screen would discard source pixels.
    // Instead, show a native-resolution window centred on the selected map.
    state.scale=1;
    const v=viewSize();
    state.tx=v.w/2-state.x;
    state.ty=v.h/2-state.y;
    constrain();render();
  }
  function changePreset(id) {
    const item=state.maps.find(e=>e.id===id);
    state.preset=item ? item.id : '';
    state.bounds=item || FULL;
    const p=rectPixels();
    state.x=(p.left+p.right)/2;
    state.y=(p.top+p.bottom)/2;
    state.moving=null;
    fitView();
    el.select.value=state.preset;
  }
  function zoomAt(x,y,steps) {
    if (!state.ready || !steps) return;
    const next=clamp(state.scale+steps,1,MAX_ZOOM);
    if (next===state.scale) return;
    const focus=screenToMap(x,y);
    state.scale=next;
    state.tx=x-focus.x*state.scale;
    state.ty=y-focus.y*state.scale;
    constrain();render();
  }
  function keepCursorVisible() {
    const c=mapToScreen(state.x,state.y),v=viewSize();
    const inset=Math.min(40,v.w*.12,v.h*.12);
    if(c.x<inset)state.tx+=inset-c.x;
    if(c.x>v.w-inset)state.tx-=c.x-(v.w-inset);
    if(c.y<inset)state.ty+=inset-c.y;
    if(c.y>v.h-inset)state.ty-=c.y-(v.h-inset);
    constrain();
  }
  function putCursor(x,y,pan=true) {
    const p=rectPixels();
    state.moving=null;
    state.x=clamp(x,p.left,p.right);
    state.y=clamp(y,p.top,p.bottom);
    if(pan)keepCursorVisible();
    render();
  }
  function direction() {
    const h=state.held;
    return {
      dx:Number(['ArrowRight','KeyD','Numpad6','Numpad3','Numpad9'].some(k=>h.has(k))) -
         Number(['ArrowLeft','KeyA','Numpad4','Numpad1','Numpad7'].some(k=>h.has(k))),
      dy:Number(['ArrowDown','KeyS','Numpad2','Numpad1','Numpad3'].some(k=>h.has(k))) -
         Number(['ArrowUp','KeyW','Numpad8','Numpad7','Numpad9'].some(k=>h.has(k)))
    };
  }
  function moveStart(now) {
    if (!state.ready || state.moving) return;
    const {dx,dy}=direction();
    if (!dx&&!dy) return;
    const step=Math.max(el.frames[0].naturalWidth/2,Math.round(15/state.scale));
    const p=rectPixels();
    const ex=clamp(state.x+dx*step,p.left,p.right),ey=clamp(state.y+dy*step,p.top,p.bottom);
    if(ex===state.x&&ey===state.y)return;
    state.moving={sx:state.x,sy:state.y,ex,ey,start:now};
    if(!state.raf)state.raf=requestAnimationFrame(tick);
  }
  function tick(now) {
    state.raf=0;
    const m=state.moving;
    if(!m)return;
    const t=clamp((now-m.start)/MOVE_MS,0,1);
    state.x=m.sx+(m.ex-m.sx)*t;
    state.y=m.sy+(m.ey-m.sy)*t;
    keepCursorVisible();render();
    if(t===1) {state.moving=null;moveStart(now);}
    if(state.moving&&!state.raf)state.raf=requestAnimationFrame(tick);
  }
  const keys=new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD',
    'Numpad8','Numpad2','Numpad4','Numpad6','Numpad1','Numpad3','Numpad7','Numpad9']);
  window.addEventListener('keydown',e=>{
    if(!state.ready || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('select,input,textarea'))return;
    if(keys.has(e.code)) {e.preventDefault();state.held.add(e.code);moveStart(performance.now());}
  });
  window.addEventListener('keyup',e=>state.held.delete(e.code));
  window.addEventListener('blur',()=>{state.held.clear();state.moving=null;});
  function point(e) {const b=el.viewport.getBoundingClientRect();return {x:e.clientX-b.left,y:e.clientY-b.top};}
  el.viewport.addEventListener('pointerdown',e=>{
    if(!state.ready || (e.pointerType==='mouse'&&e.button!==0))return;
    el.viewport.focus({preventScroll:true});
    const p=point(e);
    el.viewport.setPointerCapture(e.pointerId);
    state.pointers.set(e.pointerId,p);
    if(state.pointers.size===1)state.drag={last:p,start:p,moved:false};
    if(state.pointers.size===2) {
      const [a,b]=[...state.pointers.values()];
      const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      state.pinch={dist:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:state.scale,map:screenToMap(mid.x,mid.y)};
      state.drag=null;
    }
  });
  el.viewport.addEventListener('pointermove',e=>{
    // Intentionally no cursor movement on hover. Only click and keys select.
    if(!state.pointers.has(e.pointerId))return;
    const p=point(e);
    state.pointers.set(e.pointerId,p);
    if(state.pointers.size===2&&state.pinch) {
      const [a,b]=[...state.pointers.values()];
      const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      state.scale=clamp(Math.round(state.pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/state.pinch.dist),1,MAX_ZOOM);
      state.tx=mid.x-state.pinch.map.x*state.scale;
      state.ty=mid.y-state.pinch.map.y*state.scale;
      constrain();render();return;
    }
    if(!state.drag)return;
    const dx=p.x-state.drag.last.x,dy=p.y-state.drag.last.y;
    if(Math.hypot(p.x-state.drag.start.x,p.y-state.drag.start.y)>6)state.drag.moved=true;
    if(state.drag.moved) {
      state.tx+=dx;state.ty+=dy;
      constrain();render();el.viewport.classList.add('dragging');
    }
    state.drag.last=p;
  });
  function endPointer(e) {
    if(!state.pointers.has(e.pointerId))return;
    const isTap=state.pointers.size===1&&state.drag&&!state.drag.moved;
    const p=point(e);
    state.pointers.delete(e.pointerId);
    if(e.type==='pointerup'&&isTap) {const xy=screenToMap(p.x,p.y);putCursor(xy.x,xy.y);}
    state.drag=null;state.pinch=null;
    el.viewport.classList.remove('dragging');
  }
  el.viewport.addEventListener('pointerup',endPointer);
  el.viewport.addEventListener('pointercancel',endPointer);
  el.viewport.addEventListener('wheel',e=>{
    if(!state.ready)return;
    e.preventDefault();
    const p=point(e);
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?el.viewport.clientHeight:1);
    state.wheelDelta+=delta;
    // Consume physical wheel/trackpad movement in discrete zoom steps only.
    const steps=clamp(Math.trunc(state.wheelDelta/100),-3,3);
    if(steps){state.wheelDelta-=steps*100;zoomAt(p.x,p.y,-steps);}
  },{passive:false});
  function updateLayers() {
    el.routes.hidden=!state.routes;
    el.towns.hidden=!state.towns;
    // Base terrain is permanently visible; the terrain button clears overlays.
    el.terrainMode.classList.add('active');
    el.terrainMode.setAttribute('aria-pressed','true');
    for(const [control,key] of [[el.routesMode,'routes'],[el.townsMode,'towns']]) {
      control.classList.toggle('active',state[key]);
      control.setAttribute('aria-pressed',String(state[key]));
    }
  }
  el.terrainMode.addEventListener('click',()=>{state.routes=false;state.towns=false;updateLayers();});
  el.routesMode.addEventListener('click',()=>{state.routes=!state.routes;updateLayers();});
  el.townsMode.addEventListener('click',()=>{state.towns=!state.towns;updateLayers();});
  el.select.addEventListener('change',()=>changePreset(el.select.value));
  function resize() {
    if(!state.ready)return;
    state.tx=el.viewport.clientWidth/2-state.x*state.scale;
    state.ty=el.viewport.clientHeight/2-state.y*state.scale;
    constrain();render();
  }
  async function init() {
    try {
      await Promise.all([el.terrain,el.routes,el.towns,...el.frames].map(decode));
      state.width=el.terrain.naturalWidth;state.height=el.terrain.naturalHeight;
      for(const img of [el.routes,el.towns]) {
        if(img.naturalWidth!==state.width||img.naturalHeight!==state.height)
          throw new Error('Overlay size differs from terrain dimensions.');
      }
      await loadMetadata();
      // Keep the sprite in a sibling overlay, completely outside the zoom tree.
      // Reject stale/mismatched HTML so a broken deployment is reported clearly.
      if (!el.cursorOverlay || el.cursorOverlay.parentElement !== el.viewport.parentElement)
        throw new Error('Cursor overlay missing. Replace index.html, map.js and style.css together.');
      el.cursorOverlay.appendChild(el.cursor);
      el.cursor.style.transform='none';
      el.cursor.style.scale='1';
      // Initialise using the source sprite dimensions. render() multiplies
      // them by the current integer map zoom, preserving map-relative size.
      for (const frame of el.frames) {
        frame.style.width = `${frame.naturalWidth}px`;
        frame.style.height = `${frame.naturalHeight}px`;
        frame.style.maxWidth = 'none';
        frame.style.maxHeight = 'none';
      }
      document.documentElement.style.setProperty('--cursor-cycle',`${40000/GBA_FPS}ms`);
      for(const item of state.maps) {
        const opt=document.createElement('option');opt.value=item.id;opt.textContent=item.name;
        el.select.appendChild(opt);
      }
      updateLayers();state.ready=true;
      changePreset('');el.loading.hidden=true;
      new ResizeObserver(resize).observe(el.viewport);
    } catch(err) {report(err);}
  }
  init();
})();
