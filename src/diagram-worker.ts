import { instance } from '@viz-js/viz';
self.onmessage=async(event:MessageEvent<{source:string;dark:boolean}>)=>{
  try{
    const viz=await instance();
    const svg=viz.renderString(event.data.source,{format:'svg',engine:'dot',graphAttributes:{bgcolor:'transparent',fontcolor:event.data.dark?'#ddd':'#222'},nodeAttributes:{fontcolor:event.data.dark?'#ddd':'#222',color:event.data.dark?'#aaa':'#444',fontname:'sans-serif'},edgeAttributes:{color:event.data.dark?'#aaa':'#444',fontcolor:event.data.dark?'#ddd':'#222'}});
    self.postMessage({svg});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};
