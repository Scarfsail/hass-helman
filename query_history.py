import urllib.request
import json
import sys
from datetime import datetime, timedelta

TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI3ZmRiNjBiZTc3NzM0ZTI5ODBhMzMxYzcyOWU0MzJjZSIsImlhdCI6MTc3MjkxMjAyMSwiZXhwIjoyMDg4MjcyMDIxfQ.RAKid0gZQWYbzpWNjdlL41XbkvoMbuCJty0keJhp440"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

def get_history(entity_id, days_ago=1):
    start_time = (datetime.utcnow() - timedelta(days=days_ago)).strftime('%Y-%m-%dT00:00:00Z')
    url = f"http://127.0.0.1:8123/api/history/period/{start_time}?filter_entity_id={entity_id}"
    
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            if data and len(data) > 0:
                states = data[0]
                print(f"Got {len(states)} data points for {entity_id} starting from {start_time}")
                if len(states) > 0:
                    print("Sample points:")
                    for s in states[:5]:
                        print(f"  {s['last_changed']}: {s['state']}")
                    print("...")
                    for s in states[-5:]:
                        print(f"  {s['last_changed']}: {s['state']}")
            else:
                print(f"No data found for {entity_id}")
    except Exception as e:
        print(f"Error fetching history: {e}")

get_history("sensor.power_production_now", 1)
get_history("sensor.energy_production_today", 1)
