import asyncio
import json
import websockets

TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI3ZmRiNjBiZTc3NzM0ZTI5ODBhMzMxYzcyOWU0MzJjZSIsImlhdCI6MTc3MjkxMjAyMSwiZXhwIjoyMDg4MjcyMDIxfQ.RAKid0gZQWYbzpWNjdlL41XbkvoMbuCJty0keJhp440"

async def main():
    async with websockets.connect("ws://127.0.0.1:8123/api/websocket") as websocket:
        await websocket.recv()
        await websocket.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        await websocket.recv()
        
        # Get last 14 days
        dates = [f"2026-04-{d:02d}" for d in range(13, 28)]
        all_days = []
        for i, date in enumerate(dates):
            await websocket.send(json.dumps({"id": i+10, "type": "helman/solar_bias/inspector", "date": date}))
            try:
                response = await websocket.recv()
                data = json.loads(response)
                if data.get("success") and data["result"]["series"]["raw"]:
                    all_days.append(data["result"])
            except Exception as e:
                pass
                
        print("Analysis for 06:00, 07:00, 08:00:")
        for slot_hour in ["06", "07", "08"]:
            print(f"\nSlot hour: {slot_hour}:00")
            ratios = []
            sum_actual = 0
            sum_forecast = 0
            for day in all_days:
                date = day["date"]
                raw_pts = {p["timestamp"]: p["valueWh"] for p in day["series"]["raw"]}
                actual_pts = {p["timestamp"]: p["valueWh"] for p in day["series"]["actual"]}
                
                actual_sum = sum(v for k, v in actual_pts.items() if k[11:13] == slot_hour)
                forecast_key = None
                for k in raw_pts.keys():
                    if k[11:13] == slot_hour:
                        forecast_key = k
                        break
                
                forecast_val = raw_pts.get(forecast_key, 0) if forecast_key else 0
                
                if forecast_val > 0:
                    ratio = actual_sum / forecast_val
                    ratios.append(ratio)
                    sum_actual += actual_sum
                    sum_forecast += forecast_val
                    print(f"  {date}: Fcast={forecast_val:6.1f}, Actual={actual_sum:6.1f}, Ratio={ratio:5.2f}")
                    
            if ratios:
                ratios.sort()
                median = ratios[len(ratios)//2] if len(ratios) % 2 != 0 else (ratios[len(ratios)//2 - 1] + ratios[len(ratios)//2]) / 2
                ratio_of_sums = sum_actual / sum_forecast if sum_forecast else 0
                print(f"  --> Median of ratios: {median:.3f}")
                print(f"  --> Ratio of sums:    {ratio_of_sums:.3f}")

asyncio.run(main())
