import { featureParser, markdownSource } from './markdown-features';
import { parseFrontmatter } from './frontmatter';
import { runScript } from './script-runner';
import type { ScriptResult } from './script-runner';
export type CodeCell = {id:string;code:string;from:number;to:number;codeFrom:number;codeTo:number};
export type CellOutput = {state:'running'|'done'|'error';result?:unknown;logs?:ScriptResult['logs'];error?:string;stale:boolean};
export function codeCells(text:string):CodeCell[]{
  const cells:CodeCell[]=[];
  featureParser.parse(markdownSource(text)).iterate({enter(node){
    if(node.name==='Blockquote'||node.name==='ListItem'||node.name==='NotationMathBlock')return false;
    if(node.name!=='FencedCode')return;
    const info=node.node.getChild('CodeInfo'),body=node.node.getChild('CodeText');
    const match=info?/^(?:js|javascript)\s+cell:([A-Za-z][A-Za-z0-9_-]{0,63})$/u.exec(text.slice(info.from,info.to).trim()):null;
    if(match)cells.push({id:match[1],code:body?text.slice(body.from,body.to):'',from:node.from,to:node.to,codeFrom:body?.from??node.to,codeTo:body?.to??node.to});return false;
  }});return cells;
}
export class CellSession {
  private document={text:'',name:'',path:null as string|null};
  private version=0;private outputs=new Map<string,CellOutput>();private listeners=new Set<()=>void>();
  private active:ReturnType<typeof runScript>|null=null;private serial=0;private running=false;
  update(text:string,name:string,path:string|null){if(text===this.document.text&&path===this.document.path&&name===this.document.name)return;if(text!==this.document.text||path!==this.document.path||name!==this.document.name){this.version++;for(const output of this.outputs.values())output.stale=true;void this.stop();}this.document={text,name,path};const ids=new Set(codeCells(text).map(cell=>cell.id));for(const id of this.outputs.keys())if(!ids.has(id))this.outputs.delete(id);this.emit();}
  get(id:string){return this.outputs.get(id);}
  get busy(){return this.running;}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  private emit(){for(const listener of this.listeners)listener();}
  async stop(){const active=this.active;this.serial++;this.active=null;this.running=false;for(const value of this.outputs.values())if(value.state==='running'){value.state='error';value.error='Cell stopped.';value.stale=true;}this.emit();if(active){try{await active.stop();}catch{/* Process may have already completed. */}}}
  dispose(){void this.stop();this.listeners.clear();}
  async run(id:string,through=false){
    if(this.running)return;
    const cells=codeCells(this.document.text),target=cells.findIndex(cell=>cell.id===id);
    const fail=(message:string,failedId=id)=>{this.outputs.set(failedId,{state:'error',error:message,stale:false});this.emit();};
    if(cells.length>128)return fail('A document can run at most 128 cells.');
    if(target<0)return fail('Only top-level JavaScript cell fences can run.');
    if(new Set(cells.map(cell=>cell.id)).size!==cells.length)return fail('Cell names must be unique in this document.');
    if(!through&&cells.slice(0,target).some(cell=>this.outputs.get(cell.id)?.state!=='done'||this.outputs.get(cell.id)?.stale))return fail('Run preceding cells first, or choose Run through here.');
    const version=this.version,ticket=++this.serial,document={...this.document};this.running=true;let runningId=id;
    try{
      for(let index=through?0:target;index<=target;index++){
        if(ticket!==this.serial||version!==this.version)return;
        const cell=cells[index];runningId=cell.id;const inputs=Object.fromEntries(cells.slice(0,index).map(previous=>[previous.id,this.outputs.get(previous.id)?.result]));
        for(const downstream of cells.slice(index+1)){const output=this.outputs.get(downstream.id);if(output)output.stale=true;}
        this.outputs.set(cell.id,{state:'running',stale:false});this.emit();
        const variables=parseFrontmatter(document.text)?.values??{};
        const data=JSON.stringify({inputs,variables});if(data.length>2*1024*1024)throw new Error('Cell inputs exceed 2 MiB.');
        const code='const {inputs,variables} = JSON.parse('+JSON.stringify(data)+');\n'+cell.code;
        const cwd=document.path?.replace(/[/\\][^/\\]*$/u,'')??null;
        const execution=runScript({id:crypto.randomUUID(),code,cwd,document:{...document,selection:cell.code,from:cell.codeFrom,to:cell.codeTo}});this.active=execution;
        const result=await execution.result;
        if(ticket!==this.serial||version!==this.version)return;
        this.active=null;
        if(!result.ok){this.outputs.set(cell.id,{state:'error',error:result.error||'Cell failed.',logs:result.logs,stale:false});this.emit();break;}
        const json=JSON.stringify(result.result??null);if(json.length>1024*1024)throw new Error('Cell output exceeds 1 MiB.');
        this.outputs.set(cell.id,{state:'done',result:JSON.parse(json),logs:result.logs,stale:false});this.emit();
      }
    }catch(error){if(ticket===this.serial)fail(error instanceof Error?error.message:String(error),runningId);}
    finally{if(ticket===this.serial){this.running=false;this.active=null;this.emit();}}
  }
}
