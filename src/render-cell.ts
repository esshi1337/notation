import type { CellSession } from './cells';
export function renderCell(target:HTMLElement,id:string,session:CellSession|undefined,current:()=>boolean){
  const actions=document.createElement('div');actions.className='cell-actions';
  const label=document.createElement('strong');label.textContent=id;actions.append(label);
  const output=document.createElement('div');output.className='cell-output';output.setAttribute('aria-label','Output: '+id);
  target.append(actions,output);target.setAttribute('role','region');target.setAttribute('aria-label','Code cell: '+id);
  if(!session){output.textContent='Cells run only at the top level of their source note.';return()=>{};}
  const run=document.createElement('button');run.textContent='Run cell';run.setAttribute('aria-label','Run cell: '+id);
  const through=document.createElement('button');through.textContent='Run through here';through.setAttribute('aria-label','Run through: '+id);
  const stop=document.createElement('button');stop.textContent='Stop';stop.setAttribute('aria-label','Stop cell: '+id);
  run.onclick=event=>{event.stopPropagation();if(current())void session.run(id);};through.onclick=event=>{event.stopPropagation();if(current())void session.run(id,true);};stop.onclick=event=>{event.stopPropagation();void session.stop();};actions.append(run,through,stop);
  const update=()=>{
    const state=session.get(id);run.disabled=through.disabled=session.busy;stop.hidden=!session.busy;output.replaceChildren();
    if(!state){output.textContent='Not run';return;}
    const status=document.createElement('div');status.className='cell-status';status.textContent=state.stale?'Output is stale — rerun this cell':state.state==='running'?'Running…':state.state==='done'?'Finished':'Failed';output.append(status);
    if(state.logs?.length){const logs=document.createElement('pre');logs.textContent=state.logs.map(log=>log.message).join('\n');output.append(logs);}
    if(state.error){const error=document.createElement('div');error.setAttribute('role','alert');error.textContent=state.error;output.append(error);}
    if(state.state==='done'){const result=document.createElement('pre');result.textContent=typeof state.result==='string'?state.result:JSON.stringify(state.result,null,2);output.append(result);}
  };
  const unsubscribe=session.subscribe(()=>{if(!target.isConnected){unsubscribe();return;}update();});update();return unsubscribe;
}
