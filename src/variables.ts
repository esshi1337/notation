import { featureParser, markdownSource } from './markdown-features';
import { resolveVariable } from './templates';
export type VariableSpan={from:number;to:number;raw:string;name:string;value:string|null};
export function inlineVariables(text:string,values:Record<string,unknown>):VariableSpan[]{
  const excluded:{from:number;to:number}[]=[];const source=markdownSource(text);
  featureParser.parse(source).iterate({enter(node){if(['FencedCode','CodeBlock','InlineCode','HTMLBlock','HTMLTag','NotationMathBlock','NotationMathInline','Link','Image'].includes(node.name)){excluded.push({from:node.from,to:node.to});return false;}}});
  const result:VariableSpan[]=[];
  for(const match of source.matchAll(/\{\{([^{}\r\n]{1,256})\}\}/gu)){
    let slashes=0;for(let at=match.index-1;at>=0&&source[at]==='\\';at--)slashes++;if(slashes%2||excluded.some(range=>match.index>=range.from&&match.index<range.to))continue;
    const name=match[1].trim();result.push({from:match.index,to:match.index+match[0].length,raw:match[0],name,value:resolveVariable(name,values)});
  }
  return result;
}
