// Run against the disposable source copy for the instrumented simulator build
// (base or head). The release app has no projection reader.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import fieldScene from '../../rigs/fieldScene.cjs'

const dir = process.argv[2]
if (!dir) throw new Error('Supply the disposable simulator build source root')
const file = resolve(dir, 'src/app/field/FieldCanvas.native.tsx')
let source = await readFile(file, 'utf8')
function insert(marker, addition) {
  if (source.split(marker).length !== 2)
    throw new Error('Expected one simulator canvas marker: ' + marker)
  source = source.replace(marker, addition + marker)
}

insert(
  'import { Canvas,',
  "import {PARK} from '../../common/scoring/park'\nimport type {RootState} from '@react-three/fiber/native'\nimport type {Mesh} from 'three'\n"
)
insert(
  '  const [relay]',
  `
  const cameraState=useRef<RootState|null>(null)
  const [landmarks,setLandmarks]=useState('')
  useEffect(()=>{
    if(layout==null)return
    const timer=setInterval(()=>{
      const three=cameraState.current
      if(three==null || three.scene.getObjectByName('vintage-scoreboard')==null)return
      const project=(x:number,y:number,z:number):[number,number]=>{
        const point=three.camera.position.clone().set(x,y,z).project(three.camera)
        return [(point.x+1)*layout.width/2,(1-point.y)*layout.height/2]
      }
      const bounds=(()=>{
        ${fieldScene.BOARD_BOUNDS.replace("getObjectByName('vintage-scoreboard')", "getObjectByName('vintage-scoreboard')!").replace('traverseVisible(mesh => {', 'traverseVisible(object => { const mesh=object as Mesh;')}
      })()
      const corners=[-1,1].flatMap(sign=>[Math.PI/4,PARK.outfieldHalfAngle].map(angle=>project(sign*PARK.outfieldRadius*Math.sin(angle),0,-PARK.outfieldRadius*Math.cos(angle))))
      setLandmarks(JSON.stringify({
        size:layout,board:bounds,corners,
        projection:three.camera.projectionMatrix.toArray(),world:three.camera.matrixWorld.toArray(),
        viewport:three.gl.getContext().getParameter(three.gl.getContext().VIEWPORT)
      }))
    },350)
    return ()=>clearInterval(timer)
  },[layout])
`
)
insert(
  '            element.current = state.gl.domElement',
  '            cameraState.current=state\n'
)
insert(
  '      <FieldNameplates ',
  `
      {landmarks!=='' && <View testID="scoring-projection-reader" accessible accessibilityLabel={landmarks}
        pointerEvents="none" style={{position:'absolute',left:0,top:0,width:1,height:1}}/>}
`
)
await writeFile(file, source)
