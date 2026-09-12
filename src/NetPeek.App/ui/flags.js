// 本文件由 scripts/gen-flags.mjs 生成，请勿手改。
// 国旗：flags.png 雪碧图（flag-icons 7.2.3，MIT），270 个 32x24 单元，
//       按 CSS 背景图定位显示为 16x12 逻辑像素。
// 语义图标：内联 SVG，走 currentColor 跟随主题。

(function () {
  'use strict';

  const CELL = { w: 32, h: 24, cols: 16, rows: 17, imgW: 512, imgH: 408 };
  const INDEX = {"ad":0,"ae":1,"af":2,"ag":3,"ai":4,"al":5,"am":6,"ao":7,"aq":8,"ar":9,"arab":10,"as":11,"at":12,"au":13,"aw":14,"ax":15,"az":16,"ba":17,"bb":18,"bd":19,"be":20,"bf":21,"bg":22,"bh":23,"bi":24,"bj":25,"bl":26,"bm":27,"bn":28,"bo":29,"bq":30,"br":31,"bs":32,"bt":33,"bv":34,"bw":35,"by":36,"bz":37,"ca":38,"cc":39,"cd":40,"cefta":41,"cf":42,"cg":43,"ch":44,"ci":45,"ck":46,"cl":47,"cm":48,"cn":49,"co":50,"cp":51,"cr":52,"cu":53,"cv":54,"cw":55,"cx":56,"cy":57,"cz":58,"de":59,"dg":60,"dj":61,"dk":62,"dm":63,"do":64,"dz":65,"eac":66,"ec":67,"ee":68,"eg":69,"eh":70,"er":71,"es":72,"es-ct":73,"es-ga":74,"es-pv":75,"et":76,"eu":77,"fi":78,"fj":79,"fk":80,"fm":81,"fo":82,"fr":83,"ga":84,"gb":85,"gb-eng":86,"gb-nir":87,"gb-sct":88,"gb-wls":89,"gd":90,"ge":91,"gf":92,"gg":93,"gh":94,"gi":95,"gl":96,"gm":97,"gn":98,"gp":99,"gq":100,"gr":101,"gs":102,"gt":103,"gu":104,"gw":105,"gy":106,"hk":107,"hm":108,"hn":109,"hr":110,"ht":111,"hu":112,"ic":113,"id":114,"ie":115,"il":116,"im":117,"in":118,"io":119,"iq":120,"ir":121,"is":122,"it":123,"je":124,"jm":125,"jo":126,"jp":127,"ke":128,"kg":129,"kh":130,"ki":131,"km":132,"kn":133,"kp":134,"kr":135,"kw":136,"ky":137,"kz":138,"la":139,"lb":140,"lc":141,"li":142,"lk":143,"lr":144,"ls":145,"lt":146,"lu":147,"lv":148,"ly":149,"ma":150,"mc":151,"md":152,"me":153,"mf":154,"mg":155,"mh":156,"mk":157,"ml":158,"mm":159,"mn":160,"mo":161,"mp":162,"mq":163,"mr":164,"ms":165,"mt":166,"mu":167,"mv":168,"mw":169,"mx":170,"my":171,"mz":172,"na":173,"nc":174,"ne":175,"nf":176,"ng":177,"ni":178,"nl":179,"no":180,"np":181,"nr":182,"nu":183,"nz":184,"om":185,"pa":186,"pc":187,"pe":188,"pf":189,"pg":190,"ph":191,"pk":192,"pl":193,"pm":194,"pn":195,"pr":196,"ps":197,"pt":198,"pw":199,"py":200,"qa":201,"re":202,"ro":203,"rs":204,"ru":205,"rw":206,"sa":207,"sb":208,"sc":209,"sd":210,"se":211,"sg":212,"sh":213,"sh-ac":214,"sh-hl":215,"sh-ta":216,"si":217,"sj":218,"sk":219,"sl":220,"sm":221,"sn":222,"so":223,"sr":224,"ss":225,"st":226,"sv":227,"sx":228,"sy":229,"sz":230,"tc":231,"td":232,"tf":233,"tg":234,"th":235,"tj":236,"tk":237,"tl":238,"tm":239,"tn":240,"to":241,"tr":242,"tt":243,"tv":244,"tw":245,"tz":246,"ua":247,"ug":248,"um":249,"un":250,"us":251,"uy":252,"uz":253,"va":254,"vc":255,"ve":256,"vg":257,"vi":258,"vn":259,"vu":260,"wf":261,"ws":262,"xk":263,"xx":264,"ye":265,"yt":266,"za":267,"zm":268,"zw":269};

  const SEMANTIC = {
    loopback: '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1.5" width="12" height="7.2" rx="1.2"/><path d="M8 8.7v1.6M5.8 10.6h4.4"/></svg>',
    lan: '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M2.3 5.7 8 1.4l5.7 4.3v4.9a.7.7 0 0 1-.7.7H3a.7.7 0 0 1-.7-.7z"/><path d="M6.4 10.9V7.6h3.2v3.3"/></svg>',
    multicast: '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="10" r="1.15" fill="currentColor" stroke="none"/><path d="M5.3 7.3a3.9 3.9 0 0 1 5.4 0M3.1 5a7 7 0 0 1 9.8 0"/></svg>',
    bogon: '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="6" rx="5" ry="4.4"/><path d="M4.5 9.5 11.5 2.5"/></svg>',
    unknown: '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="6" rx="5" ry="4.4"/><ellipse cx="8" cy="6" rx="2.2" ry="4.4"/><path d="M3.2 6h9.6"/></svg>',
  };

  /** 国家码 → 背景图定位（显示像素，已按 2 倍图折半）；未知国家返回空串。 */
  function pos(cc) {
    const i = INDEX[String(cc || '').toLowerCase()];
    if (i === undefined) return '';
    const x = (i % CELL.cols) * (CELL.w / 2);
    const y = Math.floor(i / CELL.cols) * (CELL.h / 2);
    return `-${x}px -${y}px`;
  }

  /** 语义图标名 → 内联 SVG 串；名字非法返回空串。 */
  function semantic(name) {
    return SEMANTIC[name] || '';
  }

  window.NetPeekFlags = { pos, semantic, size: { w: CELL.w / 2, h: CELL.h / 2, sheetW: CELL.imgW / 2, sheetH: CELL.imgH / 2 }, count: 270 };
})();
