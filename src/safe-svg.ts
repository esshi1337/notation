import DOMPurify from 'dompurify';
export function safeSVG(svg:string):DocumentFragment {
  const fragment=DOMPurify.sanitize(svg,{USE_PROFILES:{html:true,svg:true,svgFilters:true},ADD_TAGS:['foreignObject'],ADD_ATTR:['dominant-baseline'],RETURN_DOM_FRAGMENT:true});
  const css=(value:string)=>value.replace(/@import[^;]+;/giu,'').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu,(raw,_quote,url:string)=>/^(?:#|data:)/iu.test(url.trim())?raw:'none');
  for(const element of fragment.querySelectorAll('script,iframe,object,embed,audio,video,source,link,input,button,form'))element.remove();
  for(const image of fragment.querySelectorAll('img'))if(!/^data:image\//iu.test(image.getAttribute('src')??''))image.remove();
  for(const element of fragment.querySelectorAll('*')){
    for(const attribute of [...element.attributes]){
      if(/^(?:href|xlink:href)$/iu.test(attribute.name)&&element.tagName.toLowerCase()!=='a'&&!/^(?:#|data:)/iu.test(attribute.value))element.removeAttribute(attribute.name);
      else if(attribute.value.includes('url('))element.setAttribute(attribute.name,css(attribute.value));
    }
    if(element.tagName.toLowerCase()==='style')element.textContent=css(element.textContent??'');
    if(element.tagName.toLowerCase()==='a'){element.setAttribute('target','_blank');element.setAttribute('rel','noopener noreferrer');}
  }
  return fragment;
}
