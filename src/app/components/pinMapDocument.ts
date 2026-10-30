/** Where a map is centred, the pin it shows, and whether it moves. */
export interface PinMapSettings {
  latitude: number
  longitude: number
  /** Google's browser key. Without one the map cannot load. */
  googleMapsApiKey?: string
  /** Whether the pin can be dragged. */
  editable: boolean
}

/** What every platform's PinMap takes. */
export interface PinMapProps {
  settings: PinMapSettings
  /** Where the pin was dragged to. */
  onMove?: (pin: { latitude: number; longitude: number }) => void
  /** How long Android waits for Google's map before giving up on it. */
  fallbackAfterMs?: number
}

/** The message a map posts when its pin has been dragged somewhere. */
export interface PinMoved {
  type: 'teamstation:pinMoved'
  latitude: number
  longitude: number
}

/** How long a web map's frame has to start before the panel replaces it. */
export const MAP_FRAME_READY_MS = 10000

/** What the map shows when it cannot load. */
export const PIN_MAP_FAILED = 'The map couldn’t load'

/** The point a map is on, as the failure panel names it. */
export function pinPointText(point: {
  latitude: number
  longitude: number
}): string {
  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`
}

/** Reads a posted message as a moved pin, or nothing. */
export function pinMovedOf(data: unknown): PinMoved | undefined {
  let value = data
  if (typeof value === 'string')
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  if (value == null || typeof value !== 'object') return undefined
  const moved = value as Partial<PinMoved>
  if (
    moved.type !== 'teamstation:pinMoved' ||
    typeof moved.latitude !== 'number' ||
    typeof moved.longitude !== 'number' ||
    !Number.isFinite(moved.latitude) ||
    !Number.isFinite(moved.longitude) ||
    Math.abs(moved.latitude) > 90 ||
    Math.abs(moved.longitude) > 180
  )
    return undefined
  return {
    type: moved.type,
    latitude: moved.latitude,
    longitude: moved.longitude
  }
}

function checked(settings: PinMapSettings): void {
  if (
    !Number.isFinite(settings.latitude) ||
    !Number.isFinite(settings.longitude) ||
    Math.abs(settings.latitude) > 90 ||
    Math.abs(settings.longitude) > 180
  )
    throw new Error('The place could not be located.')
}

/** Text for the markup, with nothing that could close a tag or a string. */
const escaped = (text: string): string =>
  text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

/**
 * Google's map with one advanced marker, which drags when the map is
 * editable and posts where it was let go: to the web page that framed it, or
 * to a WebView that holds it.
 *
 * A missing key, Google's `gm_authFailure`, a script that fails to load, or
 * no tiles within `timeoutMs` shows a panel instead: "The map couldn’t load",
 * the coordinates, and Retry, which loads the document again.
 */
export function pinMapDocument(
  settings: PinMapSettings,
  options: { timeoutMs?: number } = {}
): string {
  checked(settings)
  const config = JSON.stringify({
    latitude: settings.latitude,
    longitude: settings.longitude,
    key: settings.googleMapsApiKey ?? '',
    editable: settings.editable,
    timeoutMs: options.timeoutMs ?? 15000
  }).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><style>
    html,body,#map{height:100%;width:100%;margin:0}
    #failed{height:100%;box-sizing:border-box;padding:16px;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#eef2ee;color:#1d2a1f;font:15px/1.35 -apple-system,system-ui,sans-serif;text-align:center}
    #failed:not([hidden]){display:flex}
    #failed .title{font-weight:600;font-size:17px;margin:0}
    #failed .where{margin:0;font-variant-numeric:tabular-nums;color:#4a5a4d}
    #failed button{margin-top:4px;min-height:44px;padding:0 22px;border:0;border-radius:22px;background:#24452b;color:white;font:600 15px -apple-system,system-ui,sans-serif}
  </style></head><body><div id="map" aria-label="Field location map"></div><div id="failed" role="alert" hidden><p class="title">${escaped(PIN_MAP_FAILED)}</p><p class="where">${escaped(pinPointText(settings))}</p><button type="button" id="retry">Retry</button></div><script>
    (()=>{
    const config=${config};
    const post=(lat,lng)=>{const message={type:'teamstation:pinMoved',latitude:lat,longitude:lng};if(window.ReactNativeWebView!=null)window.ReactNativeWebView.postMessage(JSON.stringify(message));else if(window.parent!==window)window.parent.postMessage(message,'*')};
    let failed=false;let timeout;
    const fail=()=>{if(failed)return;failed=true;clearTimeout(timeout);document.getElementById('map').hidden=true;document.getElementById('failed').hidden=false;window.pinMapFailed=true};
    document.getElementById('retry').addEventListener('click',()=>{location.reload()});
    if(config.key===''){fail();return}
    window.gm_authFailure=fail;
    timeout=setTimeout(fail,config.timeoutMs);
    window.initPinMap=async()=>{try{
      if(failed)return;
      const {Map}=await google.maps.importLibrary('maps');
      const {AdvancedMarkerElement}=await google.maps.importLibrary('marker');
      if(failed)return;
      const center={lat:config.latitude,lng:config.longitude};
      const map=new Map(document.getElementById('map'),{center,zoom:18,mapId:'DEMO_MAP_ID',gestureHandling:'greedy',streetViewControl:false,mapTypeControl:false,mapTypeId:'hybrid'});
      const marker=new AdvancedMarkerElement({map,position:center,title:'Field location',gmpDraggable:config.editable});
      marker.addListener('dragend',()=>{const point=marker.position;post(typeof point.lat==='function'?point.lat():point.lat,typeof point.lng==='function'?point.lng():point.lng)});
      window.pinMap=map;window.pinMarker=marker;
      map.addListener('tilesloaded',()=>{clearTimeout(timeout)});
    }catch{fail()}};
    const script=document.createElement('script');script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({key:config.key,loading:'async',callback:'initPinMap',v:'quarterly'});script.async=true;script.onerror=fail;document.head.appendChild(script);
    })();
  </script></body></html>`
}
