import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskBoard } from './TaskBoard';
import { moveTask } from './api';
import type { Task } from './api';
vi.mock('./api',()=>({moveTask:vi.fn()}));
const first:Task={id:'a',projectId:'p',taskNo:1,taskKey:'P-1',title:'第一项',description:'',status:'todo',progress:0,priority:'medium',assigneeId:null,startDate:null,dueDate:null,createdBy:'user-1',version:2,boardOrder:1024};
const second:Task={...first,id:'b',taskNo:2,taskKey:'P-2',title:'第二项',version:3,boardOrder:2048};
const originalMatchMedia=window.matchMedia;
beforeAll(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:(media:string):MediaQueryList=>({matches:false,media,onchange:null,addListener:()=>undefined,removeListener:()=>undefined,addEventListener:()=>undefined,removeEventListener:()=>undefined,dispatchEvent:()=>false})});});
afterAll(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:originalMatchMedia});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('任务看板',()=>{
  it('只读展示排序且不显示移动按钮',()=>{
    render(<TaskBoard tasks={[second,first]} writable={false} onRefresh={vi.fn()}/>);
    const column=screen.getByRole('region',{name:'待处理'});expect(within(column).getAllByText(/项/).map((item)=>item.textContent)).toEqual(['第一项','第二项']);
    expect(screen.queryByRole('button',{name:'P-1 下移'})).toBeNull();
  });
  it('移动携带版本和位置并刷新',async()=>{
    vi.mocked(moveTask).mockResolvedValue({task:second,columns:{todo:[second,first]}});const refresh=vi.fn().mockResolvedValue(undefined);const user=userEvent.setup();
    render(<TaskBoard tasks={[first,second]} writable onRefresh={refresh}/>);
    await user.click(screen.getByRole('button',{name:'P-2 上移'}));
    await waitFor(()=>expect(moveTask).toHaveBeenCalledWith('b',{version:3,targetStatus:'todo',targetIndex:0}));expect(refresh).toHaveBeenCalled();
  });
  it('显示服务端冲突且不刷新',async()=>{
    vi.mocked(moveTask).mockRejectedValue(new Error('版本冲突'));const refresh=vi.fn().mockResolvedValue(undefined);const user=userEvent.setup();
    render(<TaskBoard tasks={[first,second]} writable onRefresh={refresh}/>);await user.click(screen.getByRole('button',{name:'P-2 上移'}));
    expect(await screen.findByText('版本冲突')).toBeTruthy();expect(refresh).not.toHaveBeenCalled();
  });
});
