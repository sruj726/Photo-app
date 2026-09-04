import Foundation
import Capacitor

/// Background uploader for TripLink.
///
/// The web app calls `enqueueUpload` with the queue item (blob as base64 or a file URL, member token,
/// metadata). We write the bytes to disk and upload them with a *background* URLSession, so the transfer
/// survives the app being backgrounded or suspended. When the main upload finishes we post the optional
/// thumbnail and original, then notify JS with the photo the server returned.
///
/// Events (listen from JS via Capacitor `addListener`, the web app re-dispatches them as window events):
///   "uploadDone"   { queueId, photo }
///   "uploadFailed" { queueId, permanent, error }
@objc(TripLinkNativePlugin)
public class TripLinkNativePlugin: CAPPlugin, URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {
    private let sessionId = "app.triplink.uploads"
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: sessionId)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.allowsCellularAccess = true          // the web app's Wi-Fi-only toggle gates what is handed to us
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()
    private var responses: [Int: Data] = [:]      // taskIdentifier -> body
    private let defaults = UserDefaults(suiteName: "app.triplink.uploads") ?? .standard

    private var uploadsDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - JS API

    /// enqueueUpload({ queueId, baseUrl, url, token, blobBase64 | fileUri, mime, meta, thumbBase64?, originalBase64?, originalMime? })
    @objc func enqueueUpload(_ call: CAPPluginCall) {
        guard let queueId = call.getInt("queueId"),
              let path = call.getString("url"),
              let token = call.getString("token") else { call.reject("queueId, url and token are required"); return }
        let baseUrl = call.getString("baseUrl") ?? (bridge?.config.serverURL?.absoluteString ?? "")
        guard let url = URL(string: baseUrl + path) else { call.reject("bad url"); return }

        // Persist the payload so a background session can read it after the app is suspended.
        let file = uploadsDir.appendingPathComponent("\(queueId).bin")
        do {
            if let b64 = call.getString("blobBase64"), let data = Data(base64Encoded: b64) {
                try data.write(to: file, options: .atomic)
            } else if let uri = call.getString("fileUri"), let src = URL(string: uri) {
                try? FileManager.default.removeItem(at: file)
                try FileManager.default.copyItem(at: src, to: file)
            } else { call.reject("blobBase64 or fileUri required"); return }
        } catch { call.reject("could not store upload: \(error.localizedDescription)"); return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "X-Member-Token")
        req.setValue(call.getString("mime") ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        if let meta = call.getObject("meta"), let json = try? JSONSerialization.data(withJSONObject: meta), let s = String(data: json, encoding: .utf8) {
            req.setValue(s, forHTTPHeaderField: "X-Photo-Meta")
        }
        let task = session.uploadTask(with: req, fromFile: file)
        // Remember what belongs to this task so the completion (possibly in a relaunched process) can finish the job.
        var record: [String: Any] = ["queueId": queueId, "token": token, "baseUrl": baseUrl, "file": file.path, "stage": "main"]
        if let t = call.getString("thumbBase64") { record["thumbBase64"] = t }
        if let o = call.getString("originalBase64") { record["originalBase64"] = o; record["originalMime"] = call.getString("originalMime") ?? "application/octet-stream" }
        defaults.set(record, forKey: "task-\(task.taskIdentifier)")
        task.resume()
        call.resolve(["taskId": task.taskIdentifier])
    }

    @objc func pending(_ call: CAPPluginCall) {
        session.getAllTasks { tasks in call.resolve(["count": tasks.count]) }
    }

    // MARK: - URLSession delegate

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responses[dataTask.taskIdentifier, default: Data()].append(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let key = "task-\(task.taskIdentifier)"
        guard let record = defaults.dictionary(forKey: key), let queueId = record["queueId"] as? Int else { return }
        let body = responses.removeValue(forKey: task.taskIdentifier) ?? Data()
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let stage = record["stage"] as? String ?? "main"

        if let error = error {
            // Network failure: let the web app retry (it clears nativeHandoff and uploads itself when online).
            notifyListeners("uploadFailed", data: ["queueId": queueId, "permanent": false, "error": error.localizedDescription])
            cleanup(record, key: key); return
        }
        if stage == "main" {
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            if status == 201 || status == 409, let photo = json?["photo"] as? [String: Any], let photoId = photo["id"] as? String {
                // Optional extras, fire-and-forget: thumbnail (video poster) and untouched original.
                if let baseUrl = record["baseUrl"] as? String, let token = record["token"] as? String, let tripPath = task.originalRequest?.url?.path {
                    let photoBase = baseUrl + tripPath + "/" + photoId
                    if let t = record["thumbBase64"] as? String, let d = Data(base64Encoded: t) { post(d, to: photoBase + "/thumb", token: token, mime: "image/jpeg") }
                    if let o = record["originalBase64"] as? String, let d = Data(base64Encoded: o) { post(d, to: photoBase + "/original", token: token, mime: record["originalMime"] as? String ?? "application/octet-stream") }
                }
                notifyListeners("uploadDone", data: ["queueId": queueId, "photo": photo])
            } else if status >= 400 && status < 500 && status != 429 {
                notifyListeners("uploadFailed", data: ["queueId": queueId, "permanent": true, "error": json?["error"] as? String ?? "HTTP \(status)"])
            } else {
                notifyListeners("uploadFailed", data: ["queueId": queueId, "permanent": false, "error": "HTTP \(status)"])
            }
        }
        cleanup(record, key: key)
    }

    private func post(_ data: Data, to urlString: String, token: String, mime: String) {
        guard let url = URL(string: urlString) else { return }
        let file = uploadsDir.appendingPathComponent(UUID().uuidString + ".bin")
        try? data.write(to: file)
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "X-Member-Token"); req.setValue(mime, forHTTPHeaderField: "Content-Type")
        let t = session.uploadTask(with: req, fromFile: file)
        defaults.set(["queueId": -1, "stage": "extra", "file": file.path], forKey: "task-\(t.taskIdentifier)")
        t.resume()
    }

    private func cleanup(_ record: [String: Any], key: String) {
        if let path = record["file"] as? String { try? FileManager.default.removeItem(atPath: path) }
        defaults.removeObject(forKey: key)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // Called after the app was relaunched in the background to handle completions.
        DispatchQueue.main.async { (UIApplication.shared.delegate as? BackgroundCompletionHolder)?.backgroundCompletion?() }
    }
}

/// Implement in AppDelegate: store the completion handler from
/// application(_:handleEventsForBackgroundURLSession:completionHandler:).
public protocol BackgroundCompletionHolder: AnyObject { var backgroundCompletion: (() -> Void)? { get set } }
