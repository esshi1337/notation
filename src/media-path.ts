export type MediaKind='image'|'audio'|'video'|'pdf'|'external';
export function mediaKind(source:string):MediaKind|null {
  const path=source.split(/[?#]/u)[0].toLowerCase();
  if(/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/u.test(path)||/^data:image\//iu.test(source))return'image';
  if(/\.(mp3|wav|ogg|flac|m4a|opus)$/u.test(path)||/^data:audio\//iu.test(source))return'audio';
  if(/\.(mp4|webm|ogv|mov|m4v)$/u.test(path)||/^data:video\//iu.test(source))return'video';
  if(/\.pdf$/u.test(path)||/^data:application\/pdf/iu.test(source))return'pdf';
  return /^https?:\/\//iu.test(source)?'external':null;
}
