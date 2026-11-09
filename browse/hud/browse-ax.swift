// browse-ax — the smallest possible Accessibility bridge.
//
// The browser is parked off screen while it works, and macOS clamps a window
// position to the visible frame, so "off screen" really means "app hidden".
// Hiding another application is only reachable through the Accessibility API,
// which is why this helper exists: one argument, one attribute, no dependencies.
import Cocoa
import ApplicationServices

func application(_ pid: pid_t) -> AXUIElement {
  AXUIElementCreateApplication(pid)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}

func setHidden(_ pid: pid_t, _ hidden: Bool) -> Int32 {
  AXUIElementSetAttributeValue(application(pid), kAXHiddenAttribute as CFString, hidden ? kCFBooleanTrue : kCFBooleanFalse).rawValue
}

let args = CommandLine.arguments.dropFirst()
guard let command = args.first else {
  FileHandle.standardError.write(Data("usage: browse-ax <hide|show|state> <pid>\n".utf8))
  exit(2)
}
guard let pid = pid_t(args.dropFirst().first ?? "") else {
  FileHandle.standardError.write(Data("browse-ax: pid is required\n".utf8))
  exit(2)
}

switch command {
case "hide":
  let code = setHidden(pid, true)
  if code != 0 { FileHandle.standardError.write(Data("hide failed: AXError \(code)\n".utf8)) }
  exit(code == 0 ? 0 : 1)
case "show":
  let code = setHidden(pid, false)
  if code != 0 { FileHandle.standardError.write(Data("show failed: AXError \(code)\n".utf8)) }
  exit(code == 0 ? 0 : 1)
case "state":
  let app = application(pid)
  let hidden = attribute(app, kAXHiddenAttribute as String) as? Bool ?? false
  var windows = 0
  if let list = attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] { windows = list.count }
  print("{\"pid\":\(pid),\"hidden\":\(hidden),\"windows\":\(windows)}")
  exit(0)
default:
  FileHandle.standardError.write(Data("browse-ax: unknown command \(command)\n".utf8))
  exit(2)
}
