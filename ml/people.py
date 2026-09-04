#!/usr/bin/env python3
"""Count people in a photo with YOLO (ultralytics), for TripLink's opt-in "group photos" filter.

Usage:  python3 ml/people.py <image-path>      -> prints {"people": N, "model": "yolov8n"}

Called by `node server.js --tag-people` for every untagged photo of trips that turned the feature on.
The server treats any non-zero exit / invalid JSON as "leave untagged, try again next run".

Install once on the server:  pip install ultralytics   (downloads yolov8n.pt on first use, ~6 MB)
Without ultralytics installed this script exits 3 so the server can report "tagger unavailable".
"""
import json
import sys

def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: people.py <image>"}), file=sys.stderr)
        return 2
    try:
        from ultralytics import YOLO  # type: ignore
    except Exception:  # noqa: BLE001
        print(json.dumps({"error": "ultralytics not installed: pip install ultralytics"}), file=sys.stderr)
        return 3
    model = YOLO("yolov8n.pt")
    results = model.predict(sys.argv[1], classes=[0], conf=0.35, verbose=False)  # class 0 = person
    people = sum(len(r.boxes) for r in results)
    print(json.dumps({"people": int(people), "model": "yolov8n"}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
