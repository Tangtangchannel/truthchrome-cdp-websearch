// browse-hud — the floating panel that asks a human for one thing at a time.
//
// The browser works hidden, so it never interrupts. When a page needs a person
// (a CAPTCHA wall or a sign-in form), this panel appears in the corner of the
// current desktop: it shows a live view of the page, forwards clicks and typing
// back to the real tab, and disappears the moment the wall clears.
//
// It is a non-activating panel on purpose: it must never take keyboard focus
// away from whatever the user is doing.
import Cocoa

// MARK: - tiny HTTP client

struct Bridge {
  let port: Int

  func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, done: ((Data?) -> Void)? = nil) {
    guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { done?(nil); return }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 4
    if let body {
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    URLSession.shared.dataTask(with: request) { data, _, _ in
      done?(data)
    }.resume()
  }
}

// MARK: - image view that reports clicks in normalised page coordinates

final class FrameView: NSView {
  var onTap: ((CGFloat, CGFloat) -> Void)?
  var image: NSImage? {
    didSet { needsDisplay = true }
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
    bounds.fill()
    guard let image else { return }
    image.draw(in: imageRect(), from: .zero, operation: .sourceOver, fraction: 1)
  }

  /// The rectangle the image occupies when scaled to fit, preserving aspect.
  private func imageRect() -> NSRect {
    guard let image, image.size.width > 0, image.size.height > 0 else { return bounds }
    let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
    let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
    return NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
  }

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let rect = imageRect()
    guard rect.contains(point) else { return }
    // AppKit is bottom-left origin, the page is top-left: flip Y on the way out.
    let x = (point.x - rect.minX) / rect.width
    let y = 1 - (point.y - rect.minY) / rect.height
    onTap?(x, y)
  }
}

// MARK: - app

final class HUD: NSObject, NSApplicationDelegate {
  private var panel: NSPanel!
  private var frameView: FrameView!
  private var statusLabel: NSTextField!
  private var titleLabel: NSTextField!
  private var hintLabel: NSTextField!
  private var input: NSTextField!
  private var timer: Timer?
  private var fetching = false
  private var lastStatus = ""
  private let bridge: Bridge

  init(port: Int) {
    self.bridge = Bridge(port: port)
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildPanel()
    panel.orderFrontRegardless()
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.tick()
    }
    RunLoop.main.add(timer!, forMode: .common)
  }

  private func buildPanel() {
    let size = NSSize(width: 520, height: 620)
    panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.isMovableByWindowBackground = true
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    // canJoinAllSpaces: appear on whatever desktop the user is on, without
    // switching them to another Space.
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

    let blur = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
    blur.material = .hudWindow
    blur.blendingMode = .behindWindow
    blur.state = .active
    blur.wantsLayer = true
    blur.layer?.cornerRadius = 16
    blur.layer?.masksToBounds = true
    panel.contentView = blur

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)
    stack.translatesAutoresizingMaskIntoConstraints = false
    blur.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
      stack.topAnchor.constraint(equalTo: blur.topAnchor),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: blur.bottomAnchor),
    ])

    statusLabel = label("需要你处理", size: 15, weight: .semibold, color: .white)
    titleLabel = label("", size: 12, weight: .regular, color: NSColor(calibratedWhite: 0.78, alpha: 1))
    titleLabel.lineBreakMode = .byTruncatingTail
    hintLabel = label("点一下画面里的验证，或直接在下方输入", size: 11, weight: .regular, color: NSColor(calibratedWhite: 0.62, alpha: 1))

    frameView = FrameView()
    frameView.translatesAutoresizingMaskIntoConstraints = false
    frameView.wantsLayer = true
    frameView.layer?.cornerRadius = 8
    frameView.layer?.masksToBounds = true
    frameView.onTap = { [weak self] x, y in
      self?.bridge.request("/hud/click", method: "POST", body: ["x": x, "y": y])
    }

    input = NSTextField()
    input.placeholderString = "验证码 / 账号，回车发送"
    input.target = self
    input.action = #selector(sendTyped)
    input.translatesAutoresizingMaskIntoConstraints = false

    let revealButton = button("我自己点", #selector(reveal))
    let dismissButton = button("跳过", #selector(dismiss))
    let buttons = NSStackView(views: [revealButton, dismissButton])
    buttons.orientation = .horizontal
    buttons.spacing = 8

    for view in [statusLabel, titleLabel, frameView, hintLabel, input, buttons] as [NSView] {
      stack.addArrangedSubview(view)
    }
    NSLayoutConstraint.activate([
      frameView.widthAnchor.constraint(equalToConstant: 484),
      frameView.heightAnchor.constraint(equalToConstant: 340),
      input.widthAnchor.constraint(equalToConstant: 484),
      titleLabel.widthAnchor.constraint(equalToConstant: 484),
      hintLabel.widthAnchor.constraint(equalToConstant: 484),
    ])
  }

  private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = NSFont.systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.isBezeled = false
    field.drawsBackground = false
    field.isEditable = false
    field.isSelectable = false
    return field
  }

  private func button(_ title: String, _ action: Selector) -> NSButton {
    let control = NSButton(title: title, target: self, action: action)
    control.bezelStyle = .rounded
    control.controlSize = .small
    return control
  }

  /// Place the panel in the top-right corner of the screen with the menu bar.
  private func place() {
    guard let screen = NSScreen.main else { return }
    let visible = screen.visibleFrame
    let size = panel.frame.size
    panel.setFrameOrigin(NSPoint(x: visible.maxX - size.width - 20, y: visible.maxY - size.height - 8))
  }

  private func tick() {
    bridge.request("/hud/meta") { [weak self] data in
      guard let self else { return }
      guard let data, let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        DispatchQueue.main.async { self.finish() }
        return
      }
      let active = meta["active"] as? Bool ?? false
      let status = meta["status"] as? String ?? ""
      let title = meta["title"] as? String ?? ""
      let url = meta["url"] as? String ?? ""
      DispatchQueue.main.async {
        if !active { self.finish(); return }
        if self.panel.frame.origin == .zero { self.place() }
        if status != self.lastStatus {
          self.lastStatus = status
          self.statusLabel.stringValue = status == "LOGIN" ? "这个页面需要登录" : "这个页面需要人机验证"
          self.statusLabel.textColor = status == "LOGIN" ? NSColor.systemTeal : NSColor.systemOrange
          self.hintLabel.stringValue = status == "LOGIN"
            ? "在下方输入账号后回车，或点「我自己点」在浏览器里操作"
            : "点一下画面里的验证，完成后面板会自动消失"
        }
        self.titleLabel.stringValue = title.isEmpty ? url : title
      }
      self.fetchFrame()
    }
  }

  private func fetchFrame() {
    guard !fetching else { return }
    fetching = true
    bridge.request("/hud/frame") { [weak self] data in
      guard let self else { return }
      defer { self.fetching = false }
      guard let data, let image = NSImage(data: data) else { return }
      DispatchQueue.main.async { self.frameView.image = image }
    }
  }

  @objc private func sendTyped() {
    let text = input.stringValue
    guard !text.isEmpty else { return }
    bridge.request("/hud/type", method: "POST", body: ["text": text])
    input.stringValue = ""
  }

  @objc private func reveal() {
    bridge.request("/hud/reveal", method: "POST", body: [:]) { _ in
      DispatchQueue.main.async { self.finish() }
    }
  }

  @objc private func dismiss() {
    bridge.request("/hud/dismiss", method: "POST", body: [:]) { _ in
      DispatchQueue.main.async { self.finish() }
    }
  }

  private func finish() {
    timer?.invalidate()
    timer = nil
    panel?.orderOut(nil)
    NSApp.terminate(nil)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

// MARK: - entry point

var port = 9336
for argument in CommandLine.arguments.dropFirst() where argument.hasPrefix("--port=") {
  port = Int(argument.dropFirst("--port=".count)) ?? port
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let hud = HUD(port: port)
app.delegate = hud
app.run()
