import PDFDocument from 'pdfkit';
import {existsSync} from 'node:fs';
import {documentTime} from './document.js';
import {bankLogo,uidmsLogo,formTitle,formInstruction} from './document-branding.js';

export function documentPdf(report){return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',layout:'landscape',margin:36,bufferPages:true,info:{Title:`${report.ticket} - ${report.title}`,Author:'CBC UIDMS',Subject:'Request and recorded approvals'}}),buffers=[];
 doc.on('data',chunk=>buffers.push(chunk));doc.on('end',()=>resolve(Buffer.concat(buffers)));doc.on('error',reject);
 // Use the OS font when available for multilingual employee/form text. Nothing
 // from the HTTP request can select a font file or remote resource.
 const systemFont=process.platform==='win32'&&existsSync('C:/Windows/Fonts/Nirmala.ttf')?'C:/Windows/Fonts/Nirmala.ttf':null;
 if(systemFont){doc.registerFont('Body',systemFont);doc.registerFont('Heading',systemFont);}else{doc.registerFont('Body','Helvetica');doc.registerFont('Heading','Helvetica-Bold');}
 const width=doc.page.width-72,blue='#2859a6',ink='#152e47',muted='#627388';
 const space=height=>{if(doc.y+height>doc.page.height-42)doc.addPage();};
 const heading=text=>{space(36);doc.moveDown(.8).font('Heading').fontSize(11).fillColor(blue).text(text);doc.moveDown(.5);};
 const paragraph=text=>{doc.font('Body').fontSize(9).fillColor(ink).text(String(text||'-'),{width,lineGap:3});doc.moveDown(.5);};
 const chunks=(value,columnWidth)=>{let text=String(value??'-'),parts=[];const limit=Math.max(50,Math.floor(columnWidth*2));while(text.length){let cut=Math.min(limit,text.length),seen=0;for(let i=0;i<cut;i++)if(text[i]==='\n'&&++seen===12){cut=i+1;break;}parts.push(text.slice(0,cut));text=text.slice(cut);}return parts.length?parts:['-'];};
 const table=(headers,rows,weights)=>{
  const total=weights.reduce((a,b)=>a+b,0),columns=weights.map(weight=>width*weight/total);
  const row=(cells,header=false)=>{doc.font(header?'Heading':'Body').fontSize(8);const height=Math.max(22,...cells.map((cell,i)=>doc.heightOfString(String(cell||'-'),{width:columns[i]-12})+12));space(height);const top=doc.y;let left=36;
   for(let i=0;i<cells.length;i++){doc.rect(left,top,columns[i],height).fillAndStroke(header?'#eef3fa':'#ffffff','#cbd6e2');doc.fillColor(header?blue:ink).text(String(cells[i]||'-'),left+6,top+6,{width:columns[i]-12,height:height-8});left+=columns[i];}doc.y=top+height;doc.x=36;};
  row(headers,true);for(const cells of rows){const parts=cells.map((cell,i)=>chunks(cell,columns[i])),count=Math.max(...parts.map(part=>part.length));for(let part=0;part<count;part++){if(doc.y+110>doc.page.height-42){doc.addPage();row(headers,true);}row(cells.map((_,i)=>parts[i][part]||''));}}doc.moveDown(.5);
 };
 try{
  const headerTop=doc.y,title=formTitle(report),instruction=formInstruction(report);
  doc.font('Heading').fontSize(12);const titleHeight=doc.heightOfString(title,{width:width-24});
  doc.font('Body').fontSize(8);const instructionHeight=doc.heightOfString(instruction,{width:width-24});
  const headerHeight=66+titleHeight+5+instructionHeight+12;
  doc.roundedRect(36,headerTop,width,headerHeight,5).lineWidth(.7).stroke('#cdddf3');
  doc.image(uidmsLogo,48,headerTop+9,{fit:[128,38],align:'center',valign:'center'});
  doc.image(bankLogo,doc.page.width-176,headerTop+9,{fit:[128,38],align:'center',valign:'center'});
  doc.font('Heading').fontSize(14).fillColor(ink).text('Commercial Bank of Ceylon PLC',190,headerTop+13,{width:doc.page.width-380,align:'center'});
  doc.font('Body').fontSize(8).fillColor(muted).text('Bangladesh Operations',190,headerTop+33,{width:doc.page.width-380,align:'center'});
  doc.moveTo(48,headerTop+55).lineTo(doc.page.width-48,headerTop+55).lineWidth(.7).stroke('#cdddf3');
  doc.font('Heading').fontSize(12).fillColor('#163a5d').text(title,48,headerTop+66,{width:width-24});
  doc.font('Body').fontSize(8).fillColor(muted).text(instruction,48,headerTop+66+titleHeight+5,{width:width-24});
  doc.x=36;doc.y=headerTop+headerHeight+14;
  table(['Ticket','Status','Request time (Dhaka)'],[[report.ticket,report.status,documentTime(report.requester.at)]],[1,1,2]);
  table(['Requester','Employee ID','Designation','Branch','Department'],[[report.requester.name,report.requester.employeeId,report.requester.designation,report.requester.branch,report.requester.department]],[2,1,1.5,2,2]);
  heading('Employees / beneficiaries');table(['Name','Employee ID','Designation'],report.people.map(row=>[row.name,row.employeeId,row.designation||'Not recorded']),[2,1,2]);
  heading('Requested systems and roles');table(['System','Role','Operation','Reason'],report.items.map(row=>[row.system,row.role,row.operation,row.reason]),[2,2,1,3]);
  if(report.justification){heading('Business justification / Remarks');paragraph(report.justification);}
  if(report.fields.length){heading('Submitted request details');table(['Field','Value'],report.fields.map(row=>[row.label,row.value]),[2,5]);}
  if(report.decisions.length){heading('Review decisions and remarks');table(['Role','Name','Decision','Time (Dhaka)','Remarks'],report.decisions.map(row=>[row.role,row.name,row.status,documentTime(row.at),row.remark]),[1.4,2,1,1.8,3]);}
  if(report.queries.length){heading('Queries and responses');table(['From / To','Query','Time (Dhaka)','Response'],report.queries.map(row=>[`${row.by} / ${row.to}`,row.message,documentTime(row.at),row.response?`${row.response}\n${documentTime(row.responseAt)}`:'Awaiting response']),[2,3,1.7,3]);}
  if(report.attachments.length){heading('Supporting documents');table(['Name','Scan status','Uploaded (Dhaka)'],report.attachments.map(row=>[row.name,row.status,documentTime(row.at)]),[3,1,2]);}
  heading('Request and approval record');
  const gap=12,slotWidth=(width-gap*(report.approvals.length-1))/report.approvals.length;
  doc.font('Body').fontSize(8);
  const texts=report.approvals.map(slot=>`${slot.role}\n\n${slot.entries.map(entry=>`${entry.name}\n${entry.status}\n${documentTime(entry.at)}`).join('\n\n')}`);
  const height=Math.max(...texts.map(text=>doc.heightOfString(text,{width:slotWidth})))+18;space(height+28);const top=doc.y;
  texts.forEach((text,index)=>{const x=36+index*(slotWidth+gap);doc.moveTo(x,top).lineTo(x+slotWidth,top).lineWidth(.6).stroke(muted);doc.fillColor(ink).text(text,x,top+9,{width:slotWidth});});
  doc.x=36;doc.y=top+height;doc.moveDown();doc.fontSize(7).fillColor(muted).text('Names and timestamps reflect recorded actions. Pending entries are not completed approvals. Times: Asia/Dhaka.',{width});
  const range=doc.bufferedPageRange();for(let page=range.start;page<range.start+range.count;page++){doc.switchToPage(page);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.font('Body').fontSize(7).fillColor(muted).text(`CBC internal portal / ${report.ticket} / Generated ${documentTime(report.generatedAt)} by ${report.generatedBy} / Page ${page+1} of ${range.count}`,36,doc.page.height-24,{width,lineBreak:false});doc.page.margins.bottom=bottom;}
  doc.end();
 }catch(error){doc.destroy();reject(error);}
});}
