import { useState } from 'react';
import type { AppMode, PageKey } from './types';
import {FlightProvider,useFlight} from './services/FlightContext';
import { AppShell } from './components/AppShell';
import MonitorPage from './pages/MonitorPage';
import ParametersPage from './pages/ParametersPage';
import ChartsPage from './pages/ChartsPage';
import LogsPage from './pages/LogsPage';
import HilPage from './pages/HilPage';
import ReplayPage from './pages/ReplayPage';
import DevicesPage from './pages/DevicesPage';

export default function App(){
  return <FlightProvider><AppContent/></FlightProvider>;
}
function AppContent(){
  const initialPage=(()=>{const value=new URLSearchParams(location.search).get('page');return(['monitor','parameters','charts','logs','hil','replay','devices'] as PageKey[]).includes(value as PageKey)?value as PageKey:'monitor'})();
  const [page,setPage]=useState<PageKey>(initialPage);
  const [mode,setMode]=useState<AppMode>(initialPage==='hil'?'HIL':initialPage==='replay'?'REPLAY':'MONITOR');
  const flight=useFlight(),telemetry=flight.telemetry;
  const pages={monitor:<MonitorPage telemetry={telemetry}/>,parameters:<ParametersPage/>,charts:<ChartsPage telemetry={telemetry}/>,logs:<LogsPage/>,hil:<HilPage telemetry={telemetry}/>,replay:<ReplayPage telemetry={telemetry}/>,devices:<DevicesPage connected={flight.link.connected} setConnected={()=>{}}/>} as const;
  const navigate=(p:PageKey)=>{setPage(p); if(p==='hil')setMode('HIL'); if(p==='replay')setMode('REPLAY'); if(p==='monitor')setMode('MONITOR')};
  return <AppShell page={page} onNavigate={navigate} mode={mode} connected={flight.link.connected} telemetry={telemetry}>{flight.error&&<div className="global-error">{flight.error}</div>}{pages[page]}</AppShell>;
}
