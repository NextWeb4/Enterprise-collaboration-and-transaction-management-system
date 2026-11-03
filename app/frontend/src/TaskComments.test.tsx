import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { TaskComments } from './TaskComments';
import { listTaskComments, createTaskComment, updateTaskComment, deleteTaskComment } from './api';
import type { Task, TaskComment } from './api';
vi.mock('./api',()=>({listTaskComments:vi.fn(),createTaskComment:vi.fn(),updateTaskComment:vi.fn(),deleteTaskComment:vi.fn()}));
const task:Task={id:'task1',projectId:'project',taskNo:1,taskKey:'PRJ-1',title:'任务',description:'',status:'todo',progress:0,priority:'medium',assigneeId:null,startDate:null,dueDate:null,createdBy:'me',version:1};
const identity:MeResponse={user:{id:'me',name:'用户',email:'me',status:'active',mustChangePassword:false,lastLoginAt:null,passwordChangedAt:null},organization:{name:'测试',timezone:'Asia/Shanghai'},roles:['member'],permissions:['task:comment','task:comment:moderate'],csrfToken:'csrf'};
const own:TaskComment={id:'c1',taskId:'task1',authorId:'me',content:'我的评论',createdAt:'2026-11-02T00:00:00.000Z',editedAt:null,removedAt:null,version:2};
const other:TaskComment={...own,id:'c2',authorId:'other',content:'他人评论',version:3};
const originalMatchMedia=window.matchMedia;
beforeAll(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:(media:string):MediaQueryList=>({matches:false,media,onchange:null,addListener:()=>undefined,removeListener:()=>undefined,addEventListener:()=>undefined,removeEventListener:()=>undefined,dispatchEvent:()=>false})});});
afterAll(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:originalMatchMedia});});
beforeEach(()=>{vi.mocked(listTaskComments).mockResolvedValue([own,other]);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('任务评论',()=>{
  it('只读时隐藏写操作并展示删除占位',async()=>{
    vi.mocked(listTaskComments).mockResolvedValue([{...own,content:'',removedAt:'2026-11-02T01:00:00.000Z'}]);
    render(<TaskComments task={task} identity={identity} writable={false} onClose={vi.fn()}/>);
    expect(await screen.findByText('评论已删除')).toBeTruthy();
    expect(screen.queryByRole('button',{name:'发表评论'})).toBeNull();
    expect(screen.queryByRole('button',{name:'删除'})).toBeNull();
  });
  it('提交评论并刷新列表',async()=>{
    vi.mocked(createTaskComment).mockResolvedValue({...own,id:'new',content:'新增评论',version:1});
    vi.mocked(listTaskComments).mockResolvedValueOnce([own]).mockResolvedValueOnce([own,{...own,id:'new',content:'新增评论',version:1}]);
    const user=userEvent.setup();render(<TaskComments task={task} identity={identity} writable onClose={vi.fn()}/>);
    await screen.findByText('我的评论');await user.type(screen.getByLabelText('发表评论'),'新增评论');await user.click(screen.getByRole('button',{name:'发表评论'}));
    await waitFor(()=>expect(createTaskComment).toHaveBeenCalledWith('task1','新增评论'));
    expect(await screen.findByText('新增评论')).toBeTruthy();
  });
  it('编辑评论携带版本，删除他人评论需要理由',async()=>{
    vi.mocked(updateTaskComment).mockResolvedValue({...own,version:3,content:'编辑后'});
    vi.mocked(deleteTaskComment).mockResolvedValue({success:true});
    const user=userEvent.setup();render(<TaskComments task={task} identity={identity} writable onClose={vi.fn()}/>);
    await screen.findByText('我的评论');await user.click(screen.getByRole('button',{name:'编辑'}));
    const edit=screen.getAllByRole('dialog').at(-1)!;const field=within(edit).getByLabelText('评论内容');await user.clear(field);await user.type(field,'编辑后');await user.click(within(edit).getByRole('button',{name:'OK'}));
    await waitFor(()=>expect(updateTaskComment).toHaveBeenCalledWith('c1',2,'编辑后'));
    const deletes=screen.getAllByRole('button',{name:'删除'});await user.click(deletes[1]!);
    const modal=screen.getAllByRole('dialog').at(-1)!;await user.type(within(modal).getByLabelText('删除原因'),'内容不当');await user.click(within(modal).getByRole('button',{name:'OK'}));
    await waitFor(()=>expect(deleteTaskComment).toHaveBeenCalledWith('c2',3,'内容不当'));
  });
  it('展示读取失败',async()=>{vi.mocked(listTaskComments).mockRejectedValue(new Error('读取失败'));render(<TaskComments task={task} identity={identity} writable onClose={vi.fn()}/>);expect(await screen.findByText('读取失败')).toBeTruthy();});
});

