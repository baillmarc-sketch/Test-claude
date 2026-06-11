# 🧥 WeatherWear

A personal website that learns your wardrobe and tells you what to wear based
on today's weather.

## How it works

1. **Every day**, open the **Log Outfit** tab: snap a photo of your outfit and
   tap the clothing items you're wearing. The site automatically attaches
   today's weather (temperature, feels-like, humidity, rain chance) from the
   free [Open-Meteo](https://open-meteo.com/) API.
2. **Later**, the **Today** tab asks *"How was your outfit?"* — too cold,
   comfortable, or too hot (and whether you got rained on).
3. **Over time**, WeatherWear learns the comfortable temperature range of each
   item in your wardrobe. The **Today** tab recommends what to wear by finding
   the outfits that worked for you in similar weather, with rule-based
   guidance until it has enough data (3+ feedback days). It also warns about
   rain, high humidity, and big day/night temperature swings.

The **Wardrobe** tab visualizes the learned temperature range of every item,
and you can export/import all data as JSON.

## Running it

No build step, no server-side code, no API keys. Serve the folder statically:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Or deploy to any static host (GitHub Pages, Netlify, …). Geolocation requires
HTTPS or localhost; otherwise use the city search in the location picker.

## Privacy

All photos, outfits and feedback are stored only in your browser's
localStorage. The only network calls are to Open-Meteo (weather + city
search) and BigDataCloud (reverse geocoding of your coordinates to a city
name). Photos never leave your device.

## Tech

Plain HTML/CSS/JavaScript — no frameworks, no dependencies.
