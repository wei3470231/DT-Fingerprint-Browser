import { WebContentsView, Session, BaseWindow, BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
export interface FingerprintConfig {
  schemaVersion: number; seed: string; uaString: string;
  ua: {brand:string; fullVersion:string; platform:string; platformVersion:string; arch:string; bitness:string};
  navigator: {platform:string; hardwareConcurrency:number; deviceMemory:number; languages:string[]};
  screen: {width:number; height:number; availWidth:number; availHeight:number; colorDepth:number; dpr:number};
  webgl: {vendor:string; renderer:string}; timezone:string; fonts:string;
  noise: {canvas:boolean; audio:boolean; rects:boolean}; disable:string[];
}
export interface Profile { id:string; name?:string; fp:FingerprintConfig; proxy?:string; proxyAuth?:{username:string;password:string} }
export function generateFingerprint(hint?:{language?:string;timezone?:string}): FingerprintConfig;
export function createFingerprintView(options:{profile:Profile;partitionPrefix?:string;configureSession?:(session:Session)=>void|Promise<void>}):Promise<WebContentsView>;
export interface Script { id:string;name:string;code:string;trigger:'manual'|'page-loaded';enabled:boolean;profileIds:string[];matches:string[];updatedAt:string }
export type ScriptInput = Pick<Script,'code'|'trigger'|'profileIds'> & Partial<Pick<Script,'id'|'name'|'enabled'|'matches'>>;
export interface ExecutionLog {id:string;at:string;kind:string;status:string;profileId?:string;scriptId?:string;extensionId?:string;name?:string;url?:string;source?:string;result?:unknown;error?:string;console?:unknown[];[key:string]:unknown}
export interface ExtensionRecord {id:string;name:string;version:string;manifestVersion:number;directory:string;profileIds:string[];permissions:string[];importedAt:string;compatibility:string;profiles:Array<{profileId:string;enabled:boolean;status:string;runtimeId?:string;error?:string}>}
export class AutomationManager extends EventEmitter {
  constructor(options:{storageDir:string;getProfileIds:()=>string[];timeoutMs?:number});
  state():{scripts:Script[];extensions:ExtensionRecord[];logs:ExecutionLog[]};
  attach(profileId:string,view:WebContentsView):Promise<void>;
  detach(profileId:string):void;
  saveScript(input:ScriptInput):Script;
  importScript(file:string,profileIds:string[]):Script;
  deleteScript(id:string):void;
  runScript(id:string,profileIds?:string[],source?:string):Promise<ExecutionLog[]>;
  importExtension(directory:string,profileIds:string[]):Promise<ExtensionRecord>;
  setExtensionEnabled(id:string,profileId:string,enabled:boolean):Promise<ReturnType<AutomationManager['state']>>;
  uninstallExtension(id:string):Promise<void>;
  openExtensionPopup(id:string,profileId:string,options?:{parent?:BaseWindow;show?:boolean}):Promise<BrowserWindow>;
  diagnoseExtension(id:string,profileId:string):Record<string,unknown>;
  dispose():void;
}
