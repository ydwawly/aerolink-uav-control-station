const {app,BrowserWindow}=require('electron');
const fs=require('fs');
const path=require('path');

app.whenReady().then(async()=>{
 let exitCode=0;
 try{
  const win=new BrowserWindow({width:Number(process.env.AEROLINK_CAPTURE_WIDTH)||1680,height:Number(process.env.AEROLINK_CAPTURE_HEIGHT)||945,show:false,backgroundColor:'#03101c',webPreferences:{preload:path.join(__dirname,'../electron/preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  await win.loadURL(process.env.AEROLINK_CAPTURE_URL||'http://localhost:5173');
  await new Promise(resolve=>setTimeout(resolve,1000));
  if(process.env.AEROLINK_CAPTURE_PAGE){
   const page=JSON.stringify(process.env.AEROLINK_CAPTURE_PAGE);
   await win.webContents.executeJavaScript(`document.querySelector('[data-page="'+${page}+'"]')?.click()`);
   await new Promise(resolve=>setTimeout(resolve,1200));
  }
  const image=await win.webContents.capturePage(),out=path.join(__dirname,'../artifacts/ui-smoke.png');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,image.toPNG());
  win.destroy();
 }catch(error){exitCode=1;console.error(error)}finally{app.exit(exitCode)}
});
