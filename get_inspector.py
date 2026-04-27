import asyncio
import json
import websockets

TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI3ZmRiNjBiZTc3NzM0ZTI5ODBhMzMxYzcyOWU0MzJjZSIsImlhdCI6MTc3MjkxMjAyMSwiZXhwIjoyMDg4MjcyMDIxfQ.RAKid0gZQWYbzpWNjdlL41XbkvoMbuCJty0keJhp440"

async def main():
    async with websockets.connect("ws://127.0.0.1:8123/api/websocket") as websocket:
        await websocket.recv()
        await websocket.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        await websocket.recv()
        
        # Today
        await websocket.send(json.dumps({"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-27"}))
        response1 = await websocket.recv()
        
        # Yesterday
        await websocket.send(json.dumps({"id": 2, "type": "helman/solar_bias/inspector", "date": "2026-04-26"}))
        response2 = await websocket.recv()
        
        print("TODAY:")
        try:
            data1 = json.loads(response1)
            print(json.dumps(data1, indent=2))
        except:
            print(response1)
            
        print("\nYESTERDAY:")
        try:
            data2 = json.loads(response2)
            print(json.dumps(data2, indent=2))
        except:
            print(response2)

asyncio.run(main())
