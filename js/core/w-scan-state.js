// Pure scan lifecycle helpers: discovery and ongoing pattern tracking are separate.
export const intervals=Object.freeze({'15m':900000,'1h':3600000});
export function activePatterns(record){return record.candidates??(record.active?[record.active]:[]);}
export function scanJobs(symbols,records,allowed){
 const jobs=new Map();
 for(const sym of symbols)for(const tf of Object.keys(intervals))jobs.set(sym+':'+tf,{sym,tf,key:sym+':'+tf});
 for(const r of records.values())if(allowed.has(r.sym)&&activePatterns(r).length&&!jobs.has(r.key))jobs.set(r.key,{sym:r.sym,tf:r.tf,key:r.key,tracked:true});
 return [...jobs.values()];
}
export function isStale(record,now){
 return !!record.error||!record.c.length||record.c.at(-1).t<Math.floor((now-7000)/intervals[record.tf])*intervals[record.tf]-intervals[record.tf];
}
export function trendLabel(c){
 if(c.length<25)return '1시간 흐름 확인 대기';
 let e=c[0].c,old=e;
 for(let i=1;i<c.length;i++){e+=(c[i].c-e)*2/21;if(i===c.length-6)old=e;}
 return c.at(-1).c>e&&e>old?'1시간 상승 흐름':c.at(-1).c<e&&e<old?'1시간 하락 흐름':'1시간 방향 혼재';
}
