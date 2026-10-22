// Local visual fixture: exercise the real office renderer and placement rules without mutating server data.
import type { Snapshot, ScreenTicket } from '@ai-office/shared';
import { Office3D } from './office3d/scene.ts';
import { place3d } from './office3d/layout.ts';

const snapshot = await fetch('/snapshot').then(r => r.json()) as Snapshot;
const ids=['developer','dev-a','dev-b','briefer','interpreter'];
const staff=snapshot.employees.filter(e => ids.includes(e.id));
const names=Object.fromEntries(snapshot.employees.map(e => [e.id,e.personalName ?? e.displayName]));
const office=new Office3D(document.querySelector<HTMLCanvasElement>('#scene')!,document.querySelector<HTMLElement>('#labels')!,()=>{},names);
const now=new Date();
const jobs: ScreenTicket[]=staff.map((employee,i)=>({...snapshot.tickets[0]!,id:`PREVIEW-${i}`,assigneeId:employee.id,reviewerId:'reviewer',status:'paused',pauseReason:'cap',pausedFrom:'in_progress',projectId:null}));
function show(mode: 'rest'|'near'|'work') {
  const next=new Date(now.getTime()+(mode==='near'?59:180)*60_000).toISOString().slice(11,16);
  const tickets=mode==='work'?jobs.map(t=>({...t,status:'in_progress' as const,pauseReason:null,pausedFrom:null})):jobs;
  office.update({placed:place3d(staff,tickets,{now:now.toISOString(),nextReport:next,timezone:'UTC'}),night:false,background:'white',approvals:0,cat:null});
  document.querySelector('#state')!.textContent=mode==='rest'?'상한 도달 · 다음 보고까지 3시간 · 캐릭터별 휴식':mode==='near'?'다음 보고까지 59분 · 업무 자리로 복귀':'작업 재개 · 업무 자리에서 타이핑';
}
show('rest');
document.querySelectorAll<HTMLButtonElement>('[data-id]').forEach(button=>button.onclick=()=>office.focus(button.dataset.id!,true));
document.querySelector<HTMLButtonElement>('#home')!.onclick=()=>office.goHome();
document.querySelector<HTMLButtonElement>('#near-report')!.onclick=()=>show('near');
document.querySelector<HTMLButtonElement>('#resume')!.onclick=()=>show('work');
document.querySelector<HTMLButtonElement>('#reset')!.onclick=()=>show('rest');
window.addEventListener('pagehide',()=>office.dispose(),{once:true});
