<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="client/public/brand/logo.png" />
    <img src=".github/logo-light.png" alt="AirSports" width="220" />
  </picture>
</p>

# AirSports

Tennis on a big screen where your phone is the racquet.

Open the game on a TV or laptop, scan the QR code with your phone and swing it like a racquet. The phone streams its motion to the game, so the racquet on screen moves the way your hand does. You play in first person from your side of the court.

If you're on your own you play against the computer. If a second phone joins, the screen splits in two (Player 1 on top, Player 2 below) and you play each other.

## How to play

1. Open the game on the big screen.
2. Scan the QR code with your phone and tap **Tap to connect racquet**. You're Player 1.
3. Want to play a friend? They scan the same code and become Player 2. Otherwise you'll get the computer.
4. Press **Start**.
5. When it's your serve, tap **Bounce ball** on your phone, then swing.

Swing harder to hit harder. Turning the phone turns the racquet, so the angle you hold it at is the angle you hit with.

### Keyboard

These are handy when you're testing without phones:

| Key | What it does |
| --- | --- |
| Enter / Space | Start the match from the lobby |
| Esc | Back to the lobby |
| B, Space | Player 1 bounces / swings |
| N, M | Player 2 bounces / swings |
| D | Show the performance overlay |

## Running it locally

You need Node 20.19 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Your phone can't reach `localhost`, and phones only share motion data over HTTPS anyway. The easy fix is a Cloudflare tunnel (install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) first):

```bash
npm run tunnel
```

It prints a `https://...trycloudflare.com` address. Open the game from that address on the big screen and the QR code will point phones at it too.

## Running it in production

```bash
npm run build
npm start
```

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `PUBLIC_URL` | the page's own address | Address the QR code sends phones to, e.g. `https://airsports.raulbazaz.me` |

It's one Node server (Express and Socket.IO) that serves the pages and relays the phone input. Rooms are kept in memory, so run a single instance. With two, a phone and the screen could end up on different servers and never find each other.

## What's in here

```
client/game/        the big screen: lobby, 3D court (three.js), match rules, HUD
client/controller/  the phone page: joining a room, reading the motion sensors
client/public/      the player model, logo and icons
server/             Express and Socket.IO, rooms and seats
shared/             message types used by both sides
scripts/            room tests and the model conversion scripts
assets/             source files (logo, original FBX models)
```

## Tests

```bash
npm run typecheck
npm run test:m1
```

`test:m1` starts its own server and checks joining, the two seats, a full room and reconnecting.

## Contributing

`main` is protected. Make a branch, push it and open a pull request. It gets merged once it's reviewed.
