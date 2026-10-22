import { describe, expect, it } from 'vitest';
import type { ScreenEmployee, ScreenTicket } from '@ai-office/shared';
import { canRest, reportWaitMs, restMotion, restProfile, REST_PROFILES, REST_SEATS, type RestContext } from './rest.ts';
import { DESK_SEATS, place3d, VISITOR_SEATS } from './layout.ts';
import * as T from 'three';
import { buildRestProps, updateRestProps } from './rest-props.ts';

const context: RestContext = { now: '2026-10-22T09:00:00.000Z', nextReport: '22:00', timezone: 'Asia/Seoul' };
const job = (patch: Partial<ScreenTicket> = {}): ScreenTicket => ({
  id:'T-1',orderId:'O-1',projectId:null,title:'작업',type:'coding',status:'paused',pausedFrom:'in_progress',pauseReason:'cap',assigneeId:'developer',reviewerId:'reviewer',
  reworkCount:0,needsCeoApproval:false,branch:null,startedAt:null,finishedAt:null,tokensUsed:0,turnsUsed:0,lowPrecision:false,...patch,
});
const employee = (id: string, patch: Partial<ScreenEmployee> = {}): ScreenEmployee => ({
  id,displayName:id,role:'developer',department:'개발팀',rank:'member',job:'',personalName:null,portrait:null,model:null,brainLabel:'Claude',spriteSet:id,isTemporary:false,tempKind:null,leftAt:null,...patch,
});

describe('scheduled quota breaks', () => {
  it('includes exactly one hour, excludes 59m59s and counts elapsed time without a new snapshot', () => {
    const edge = {...context,nextReport:'19:00'};
    expect(reportWaitMs(edge)).toBe(3_600_000);
    expect(canRest('developer',[job()],edge)).toBe(true);
    expect(canRest('developer',[job()],{...edge,clock:Date.parse(edge.now)+1000})).toBe(false);
    expect(canRest('developer',[job()],{...edge,now:'2026-10-22T09:00:00.001Z'})).toBe(false);
  });
  it('handles next-day reports, time zones, report time and invalid data safely', () => {
    expect(reportWaitMs({...context,now:'2026-10-22T14:30:00Z',nextReport:'01:00'})).toBe(90*60_000);
    expect(reportWaitMs({...context,nextReport:'09:00',timezone:'UTC'})).toBe(0);
    expect(reportWaitMs({...context,nextReport:'bad'})).toBe(-1);
    expect(reportWaitMs({...context,timezone:'invalid-zone'})).toBe(-1);
    expect(reportWaitMs({...context,clock:Date.parse(context.now)+5*3_600_000})).toBeLessThan(0);
    expect(canRest('developer',[job()])).toBe(false);
  });
  it('only cap/budget pauses qualify and other active work, review, meeting or a blocker wins', () => {
    for(const pauseReason of ['cap','budget'] as const) expect(canRest('developer',[job({pauseReason})],context)).toBe(true);
    for(const pauseReason of ['ceo-stop','offline','system-error',null] as const) expect(canRest('developer',[job({pauseReason})],context)).toBe(false);
    for(const status of ['in_progress','rework','meeting','blocked'] as const) expect(canRest('developer',[job(),job({id:'T-2',status})],context)).toBe(false);
    expect(canRest('developer',[job(),job({id:'T-2',status:'in_review',assigneeId:'dev-a',reviewerId:'developer'})],context)).toBe(false);
    expect(canRest('developer',[job({status:'done'})],context)).toBe(false);
  });
  it('a paused review sends only the interrupted reviewer to rest', () => {
    const tickets=[job({pausedFrom:'in_review'})];
    expect(canRest('reviewer',tickets,context)).toBe(true);
    expect(canRest('developer',tickets,context)).toBe(false);
    expect(canRest('reviewer',[job()],context)).toBe(false);
  });
  it('separates seats for all permanent staff and keeps occupied visitor stools free', () => {
    const ids = Object.keys(REST_PROFILES);
    const staff = [...ids.map(id => employee(id)), employee('visitor',{isTemporary:true})];
    const tickets = ids.map((assigneeId,i) => job({id:`T-${i}`,assigneeId}));
    const placed = place3d(staff,tickets,context);
    const resting = placed.filter(p => p.rest);
    expect(resting).toHaveLength(ids.length);
    expect(new Set(placed.map(p => `${p.seat.x}:${p.seat.z}`)).size).toBe(placed.length);
    expect(placed.find(p => p.id==='visitor')!.seat).toBe(VISITOR_SEATS[0]);
    expect(resting.every(p => REST_SEATS.includes(p.seat as typeof REST_SEATS[number]))).toBe(true);
    expect(place3d([...staff].reverse(),tickets,context)).toEqual(placed);
  });
  it('returns to the assigned desk as a report approaches or work resumes', () => {
    const staff=[employee('developer')];
    expect(place3d(staff,[job()],context)[0]).toMatchObject({act:'rest',rest:{kind:'coffee'}});
    for(const p of [place3d(staff,[job()],{...context,nextReport:'18:59'})[0],place3d(staff,[job({status:'in_progress',pausedFrom:null,pauseReason:null})],context)[0]]) {
      expect(p!.seat).toBe(DESK_SEATS.developer);
      expect(p!.rest).toBeUndefined();
    }
    expect(place3d(staff,[job({status:'in_progress'})],context)[0]!.act).toBe('type');
    expect(place3d([employee('developer',{leftAt:context.now})],[job()],context)).toEqual([]);
  });
  it('keeps even smaller characters shins outside the deep sofa cushions', () => {
    for(const seat of REST_SEATS.filter(s=>s.zone==='lounge')) {
      const sofaCenter=seat.face===1?8.15:10.35;
      expect(Math.abs(seat.z+seat.face*0.315-sofaCenter)).toBeGreaterThan(0.85/2);
    }
  });
  it('gives characters distinct rest habits and smooth coffee/stretches with static reduced motion', () => {
    expect(new Set(Object.values(REST_PROFILES).map(p => p.kind)).size).toBe(4);
    const coffee=restProfile('developer');
    expect(restMotion(coffee,6/coffee.pace,0,1).sip).toBe(1);
    expect(restMotion(coffee,12/coffee.pace,0,1).sip).toBe(0);
    for(const profile of Object.values(REST_PROFILES)) {
      expect(restMotion(profile,0,1,0)).toEqual(restMotion(profile,100,2,0));
      const poses = [restMotion(profile,0,0,1),restMotion(profile,5,0,1)];
      expect(poses[0]).not.toEqual(poses[1]);
      poses.forEach(p => expect(p.arms.every(n => Number.isFinite(n) && n > -2 && n < 1)).toBe(true));
    }
  });
  it('held coffee follows the animated wrist in body space and disappears when work resumes', () => {
    const body = new T.Group(); body.position.set(12,0.16,9.35); body.rotation.y = Math.PI; body.scale.setScalar(0.9);
    const wrist = new T.Group(); wrist.position.set(0.15,0.9,0.4); body.add(wrist);
    const props = buildRestProps(() => new T.MeshBasicMaterial()); body.add(props.root);
    const profile = {...restProfile('developer'),side:0 as const};
    updateRestProps(props,body,[wrist],profile,true,0,0);
    expect(props.root.visible).toBe(true); expect(props.cup.visible).toBe(true); expect(props.book.visible).toBe(false);
    const before=props.cup.position.clone(); wrist.position.y+=0.25;
    updateRestProps(props,body,[wrist],profile,true,1,1);
    expect(props.cup.position.y-before.y).toBeCloseTo(0.25);
    expect(props.cup.position.x).toBeCloseTo(before.x);
    updateRestProps(props,body,[wrist],undefined,true,0,0);
    expect(props.root.visible).toBe(false);
  });
});
