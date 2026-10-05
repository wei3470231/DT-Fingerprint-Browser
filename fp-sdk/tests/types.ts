import { BaseWindow } from 'electron';
import { AutomationManager, createFingerprintView, generateFingerprint, Profile } from '..';

async function integrate(storageDir: string) {
  const profile: Profile = { id: 'types-example', fp: generateFingerprint({ language: 'zh-CN', timezone: 'Asia/Shanghai' }) };
  const view = await createFingerprintView({ profile, configureSession(session) { session.setPermissionCheckHandler(() => false); } });
  const manager = new AutomationManager({ storageDir, getProfileIds: () => [profile.id] });
  await manager.attach(profile.id, view);
  const script = manager.saveScript({ code: 'return document.title;', trigger: 'manual', profileIds: [profile.id] });
  const logs = await manager.runScript(script.id);
  const extension = await manager.importExtension('C:/example-extension', [profile.id]);
  await manager.setExtensionEnabled(extension.id, profile.id, true);
  await manager.openExtensionPopup(extension.id, profile.id, { parent: new BaseWindow() });
  manager.on('changed', () => manager.state());
  manager.dispose();
  return logs;
}
void integrate;
