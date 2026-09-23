import type { HTMLAttributes, SVGProps } from "react";
import "./icons.css";

import plusRaw from "./svg/plus.svg?raw";
import importRaw from "./svg/import.svg?raw";
import copyRaw from "./svg/copy.svg?raw";
import editRaw from "./svg/edit.svg?raw";
import trashRaw from "./svg/trash.svg?raw";
import testRaw from "./svg/test.svg?raw";
import shareRaw from "./svg/share.svg?raw";
import flaskRaw from "./svg/flask.svg?raw";
import profileRaw from "./svg/profile.svg?raw";
import themeRaw from "./svg/theme.svg?raw";
import closeRaw from "./svg/close.svg?raw";
import saveRaw from "./svg/save.svg?raw";
import saveAsRaw from "./svg/save-as.svg?raw";
import userRaw from "./svg/user.svg?raw";
import diceRaw from "./svg/dice.svg?raw";
import listRaw from "./svg/list.svg?raw";
import shieldRaw from "./svg/shield.svg?raw";
import menuRaw from "./svg/menu.svg?raw";
import chartRaw from "./svg/chart.svg?raw";
import pingRaw from "./svg/ping.svg?raw";
import lockRaw from "./svg/lock.svg?raw";
import osWindowsRaw from "./svg/os-windows.svg?raw";
import osMacosRaw from "./svg/os-macos.svg?raw";
import osLinuxRaw from "./svg/os-linux.svg?raw";
import osAndroidRaw from "./svg/os-android.svg?raw";
import osIosRaw from "./svg/os-ios.svg?raw";
import appHappRaw from "./svg/app-happ.svg?raw";
import appFlclashxRaw from "./svg/app-flclashx.svg?raw";
import appV2raytunRaw from "./svg/app-v2raytun.svg?raw";
import appKoalaClashRaw from "./svg/app-koala-clash.svg?raw";
import appPrizrakBoxRaw from "./svg/app-prizrak-box.svg?raw";
import appClashmiRaw from "./svg/app-clashmi.svg?raw";
import appShadowrocketRaw from "./svg/app-shadowrocket.svg?raw";

type IconProps = SVGProps<SVGSVGElement>;

function RawIcon({ raw, className = "", ...props }: { raw: string } & IconProps) {
  const rest = props as unknown as HTMLAttributes<HTMLSpanElement>;
  return (
    <span
      {...rest}
      className={`app-svg-icon ${className}`.trim()}
      aria-hidden={props["aria-label"] ? undefined : true}
      dangerouslySetInnerHTML={{ __html: raw }}
    />
  );
}

export function PlusIcon(props: IconProps) { return <RawIcon raw={plusRaw} {...props} />; }
export function ImportIcon(props: IconProps) { return <RawIcon raw={importRaw} {...props} />; }
export function CopyIcon(props: IconProps) { return <RawIcon raw={copyRaw} {...props} />; }
export function EditIcon(props: IconProps) { return <RawIcon raw={editRaw} {...props} />; }
export function TrashIcon(props: IconProps) { return <RawIcon raw={trashRaw} {...props} />; }
export function TestIcon(props: IconProps) { return <RawIcon raw={testRaw} {...props} />; }
export function ShareIcon(props: IconProps) { return <RawIcon raw={shareRaw} {...props} />; }
export function FlaskIcon(props: IconProps) { return <RawIcon raw={flaskRaw} {...props} />; }
export function ProfileIcon(props: IconProps) { return <RawIcon raw={profileRaw} {...props} />; }
export function ThemeIcon(props: IconProps) { return <RawIcon raw={themeRaw} {...props} />; }
export function CloseIcon(props: IconProps) { return <RawIcon raw={closeRaw} {...props} />; }
export function SaveIcon(props: IconProps) { return <RawIcon raw={saveRaw} {...props} />; }
export function SaveAsIcon(props: IconProps) { return <RawIcon raw={saveAsRaw} {...props} />; }
export function UserIcon(props: IconProps) { return <RawIcon raw={userRaw} {...props} />; }
export function DiceIcon(props: IconProps) { return <RawIcon raw={diceRaw} {...props} />; }
export function ListIcon(props: IconProps) { return <RawIcon raw={listRaw} {...props} />; }
export function ShieldIcon(props: IconProps) { return <RawIcon raw={shieldRaw} {...props} />; }
export function ChartIcon(props: IconProps) { return <RawIcon raw={chartRaw} {...props} />; }
export function PingIcon(props: IconProps) { return <RawIcon raw={pingRaw} {...props} />; }
export function LockIcon(props: IconProps) { return <RawIcon raw={lockRaw} {...props} />; }
export function MenuIcon(props: IconProps) { return <RawIcon raw={menuRaw} {...props} />; }
export function OsWindowsIcon(props: IconProps) { return <RawIcon raw={osWindowsRaw} {...props} />; }
export function OsMacosIcon(props: IconProps) { return <RawIcon raw={osMacosRaw} {...props} />; }
export function OsLinuxIcon(props: IconProps) { return <RawIcon raw={osLinuxRaw} {...props} />; }
export function OsAndroidIcon(props: IconProps) { return <RawIcon raw={osAndroidRaw} {...props} />; }
export function OsIosIcon(props: IconProps) { return <RawIcon raw={osIosRaw} {...props} />; }
export function AppHappIcon(props: IconProps) { return <RawIcon raw={appHappRaw} {...props} />; }
export function AppFlclashxIcon(props: IconProps) { return <RawIcon raw={appFlclashxRaw} {...props} />; }
export function AppV2raytunIcon(props: IconProps) { return <RawIcon raw={appV2raytunRaw} {...props} />; }
export function AppKoalaClashIcon(props: IconProps) { return <RawIcon raw={appKoalaClashRaw} {...props} />; }
export function AppPrizrakBoxIcon(props: IconProps) { return <RawIcon raw={appPrizrakBoxRaw} {...props} />; }
export function AppClashmiIcon(props: IconProps) { return <RawIcon raw={appClashmiRaw} {...props} />; }
export function AppShadowrocketIcon(props: IconProps) { return <RawIcon raw={appShadowrocketRaw} {...props} />; }

/** Иконка ОС по ключу устройства из подписки. */
export function osIconFor(os: string): ((props: IconProps) => JSX.Element) | null {
  switch (String(os || "").trim().toLowerCase()) {
    case "windows": return OsWindowsIcon;
    case "macos": case "mac": return OsMacosIcon;
    case "linux": return OsLinuxIcon;
    case "android": return OsAndroidIcon;
    case "ios": case "iphone": case "ipados": return OsIosIcon;
    default: return null;
  }
}

/** Иконка клиентского приложения по его ключу. */
export function appIconFor(app: string): ((props: IconProps) => JSX.Element) | null {
  switch (String(app || "").trim().toLowerCase()) {
    case "happ": return AppHappIcon;
    case "flclashx": case "flclash": return AppFlclashxIcon;
    case "v2raytun": return AppV2raytunIcon;
    case "koala-clash": case "koalaclash": return AppKoalaClashIcon;
    case "prizrak-box": case "prizrakbox": return AppPrizrakBoxIcon;
    case "clashmi": return AppClashmiIcon;
    case "shadowrocket": return AppShadowrocketIcon;
    default: return null;
  }
}
