const { remote } = require('webdriverio');
const fs = require('fs');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function tapAt(driver, x, y) {
  const a=[{type:'pointer',id:'touch',parameters:{pointerType:'touch'},actions:[
    {type:'pointerMove',duration:0,x,y},{type:'pointerDown',button:0},{type:'pause',duration:80},{type:'pointerUp',button:0}
  ]}];
  await driver.performActions(a); await driver.releaseActions();
}
function parseSource(xml) {
  const els=[],re=/<([\w.]+)(\s[^>]*?)?\s*\/?>/g;let m;
  while((m=re.exec(xml))!==null){const tag=m[1];if(tag==='?xml'||tag==='hierarchy')continue;
    const el={_tag:tag},ar=/([\w-]+)="([^"]*)"/g;let a;
    while((a=ar.exec(m[2]||''))!==null)el[a[1]]=a[2];els.push(el);}return els;
}
async function main() {
  const driver = await remote({
    hostname:'127.0.0.1',port:4723,logLevel:'warn',
    capabilities:{platformName:'Android','appium:deviceName':'emulator-5554',
      'appium:appPackage':'com.swapcard.apps.android.asiatechxsg',
      'appium:appActivity':'com.swapcard.apps.android.ui.main.MainActivity',
      'appium:automationName':'UiAutomator2','appium:noReset':true}
  });
  
  const xml = await driver.getPageSource();
  const els = parseSource(xml);
  
  // Look for messages tab in bottom nav by finding clickable items near bottom of screen
  const PKG='com.swapcard.apps.android.asiatechxsg';
  // Find bottom nav items
  const navItems = els.filter(e => e.clickable==='true').map(e => {
    const m = e.bounds && e.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!m) return null;
    return {y1:+m[2],y2:+m[4],x1:+m[1],x2:+m[3],cx:Math.round((+m[1]+ +m[3])/2),cy:Math.round((+m[2]+ +m[4])/2),rid:e['resource-id']||''};
  }).filter(Boolean).filter(b=>b.y1>2100);
  
  console.log('Bottom nav items:', navItems.map(b=>`${b.rid}@(${b.cx},${b.cy})`).join(', '));
  
  // Look for Messages text in the xml
  const msgTexts = els.filter(e=>e.text&&e.text.includes('Messages'));
  console.log('Messages text els:', msgTexts.map(e=>`${e.text}@${e.bounds}`).join(', '));
  
  await driver.deleteSession();
}
main().catch(e=>console.error(e));
