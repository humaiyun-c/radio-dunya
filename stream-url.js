// Strip the optional pre-roll directives found in directory links at playback.
// Keep station identity, access/session keys, consent, and all other URL bytes.
export function cleanStreamUrl(value) {
  if(typeof value!=='string') return value;
  try { if(new URL(value).protocol!=='https:') return value; } catch { return value; }
  const hashAt=value.indexOf('#');
  const base=hashAt<0?value:value.slice(0,hashAt), fragment=hashAt<0?'':value.slice(hashAt);
  const queryAt=base.indexOf('?');
  if(queryAt<0) return value;
  const parts=base.slice(queryAt+1).split('&');
  const decode=part=>{
    const equal=part.indexOf('=');
    try {
      return [decodeURIComponent((equal<0?part:part.slice(0,equal)).replace(/\+/g,' ')).toLowerCase(),
        decodeURIComponent((equal<0?'':part.slice(equal+1)).replace(/\+/g,' '))];
    } catch { return ['', '']; }
  };
  const fields=parts.map(decode);
  // A signature can cover the entire query; changing even one field can fail it.
  if(fields.some(([key])=>/^(?:sig|signature|hmac|hdnts|hdntl|policy|x-amz-.*|x-goog-.*)$/.test(key))) return value;
  const kept=parts.filter((part,index)=>{
    const [key,data]=fields[index];
    return !(key==='mode'&&data.toLowerCase()==='preroll')
      && !(key==='aw_0_1st.bauer_preroll'&&data==='~REQUEST_PREROLL~');
  });
  if(kept.length===parts.length) return value;
  const query=kept.join('&');
  return base.slice(0,queryAt)+(query?'?'+query:'')+fragment;
}
