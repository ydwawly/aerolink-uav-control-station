import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function Panel({title,children,className='',action}:{title?:ReactNode;children:ReactNode;className?:string;action?:ReactNode}){return <section className={'panel '+className}>{title&&<div className="panel-title"><span>{title}</span>{action??<span/>}</div>}{children}</section>}
export function StatusDot({label='正常',warn=false}:{label?:string;warn?:boolean}){return <span className={warn?'status warn':'status'}><i/>{label}</span>}
export function Metric({label,value,accent=false}:{label:string;value:ReactNode;accent?:boolean}){return <div className="metric"><span>{label}</span><b className={accent?'accent':''}>{value}</b></div>}
export function SelectBox({children}:{children:ReactNode}){return <button className="selectbox"><span>{children}</span><ChevronDown size={14}/></button>}
export function Progress({value,color='green'}:{value:number;color?:'green'|'blue'|'orange'}){return <div className="progress"><i className={color} style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div>}
export function Tag({children,kind='green'}:{children:ReactNode;kind?:'green'|'blue'|'orange'|'red'}){return <span className={'tag '+kind}>{children}</span>}
export function Button({children,kind='',onClick,disabled=false,title}:{children:ReactNode;kind?:string;onClick?:()=>void;disabled?:boolean;title?:string}){return <button className={'btn '+kind} onClick={onClick} disabled={disabled} title={title}>{children}</button>}
