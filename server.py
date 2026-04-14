from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import random, string, time, hmac

app = Flask(__name__, static_folder='.')
CORS(app)

rooms = {}

COLORS           = ['#f72585','#4cc9f0','#06d6a0','#f8961e','#7209b7','#90e0ef','#ff6b6b','#ffd93d']
MAX_ROOMS        = 100
MAX_PLAYERS      = 20
MAX_NAME         = 18
ROOM_TTL         = 3600 * 4   # seconds before idle room is purged
MAX_ROOMS_PER_IP = 5          # per IP per hour
IP_WINDOW        = 3600       # seconds

# Per-IP creation log: {ip: [timestamp, ...]}
ip_creation_log: dict = {}


# ── Helpers ──────────────────────────────

def gen_code():
    return ''.join(random.choices(string.ascii_uppercase, k=4))

def safe_json():
    return request.get_json(silent=True, force=True)

def err(msg, code=400):
    return jsonify({'error': msg}), code

def touch(room):
    room['lastActive'] = time.time()

def purge_stale_rooms():
    now   = time.time()
    stale = [c for c, r in rooms.items() if now - r['lastActive'] > ROOM_TTL]
    for c in stale:
        del rooms[c]
    # Also evict IP log entries that are entirely outside the window
    for ip in list(ip_creation_log.keys()):
        ip_creation_log[ip] = [t for t in ip_creation_log[ip] if now - t < IP_WINDOW]
        if not ip_creation_log[ip]:
            del ip_creation_log[ip]

def validate_pid(d, room):
    pid    = str((d or {}).get('id', '')).strip()[:64]
    player = next((p for p in room['players'] if p['id'] == pid), None)
    if player:
        player['lastSeen'] = time.time()   # keep presence timestamp fresh
    return player

def next_active_idx(room):
    players = room['players']
    n       = len(players)
    start   = (room['currentPlayerIdx'] + 1) % n
    for offset in range(n):
        idx = (start + offset) % n
        if players[idx]['rank'] is None:
            return idx
    return 0

def count_lines(card, marked, gs):
    s = set(marked)
    n = 0
    for r in range(gs):
        if all(card[r*gs+c] in s for c in range(gs)): n += 1
    for c in range(gs):
        if all(card[r*gs+c] in s for r in range(gs)): n += 1
    if all(card[i*gs+i] in s for i in range(gs)): n += 1
    if all(card[i*gs+(gs-1-i)] in s for i in range(gs)): n += 1
    return n

def make_player(pid, name, color):
    return {'id':pid,'name':name,'color':color,'card':None,'ready':False,
            'markedNumbers':[],'bingoLines':0,'rank':None,'lastSeen':time.time()}

def _finalize(room):
    """Assign ranks to unranked players when all numbers are exhausted."""
    if room['status'] == 'ended':
        return  # already finalized via /mark — do nothing
    unranked = sorted([p for p in room['players'] if p['rank'] is None],
                      key=lambda p: -p['bingoLines'])
    for p in unranked:
        p['rank'] = len(room['rankings']) + 1
        room['rankings'].append({'id':p['id'],'name':p['name'],'color':p['color'],
                                 'rank':p['rank'],'bingoLines':p['bingoLines']})
    room['status'] = 'ended'

def _sanitize(room):
    """
    Return a JSON-safe copy of room with sensitive fields removed:
    - Strips 'password' and 'lastActive' from the top level.
    - Strips every player's 'card' (prevents opponents reading each
      other's card arrangement via the polling API).
    - Deep-copies player dicts so live objects can never be mutated
      through the sanitised output.
    """
    out = {k: v for k, v in room.items() if k not in ('password', 'lastActive')}
    out['hasPassword'] = bool(room.get('password', ''))
    # Deep-copy players, removing card field; compute online presence
    now = time.time()
    out['players'] = [
        {**{k: v for k, v in p.items() if k not in ('card', 'lastSeen')},
         'online': (now - p.get('lastSeen', 0)) < 10}
        for p in room['players']
    ]
    return out


def _check_password(stored: str, supplied: str) -> bool:
    """Constant-time password comparison to prevent timing attacks."""
    if not stored:
        return True   # no password set — always passes
    # hmac.compare_digest requires same type; encode both to bytes
    return hmac.compare_digest(stored.encode(), supplied.encode())


def _check_ip_rate_limit(ip: str) -> bool:
    """Return True if this IP is allowed to create another room."""
    now  = time.time()
    log  = ip_creation_log.get(ip, [])
    # Drop entries older than the window
    log  = [t for t in log if now - t < IP_WINDOW]
    ip_creation_log[ip] = log
    return len(log) < MAX_ROOMS_PER_IP


def _record_ip_creation(ip: str) -> None:
    now = time.time()
    ip_creation_log.setdefault(ip, []).append(now)


# ── Static files ─────────────────────────

@app.route('/')
def index():
    return send_from_directory('.', 'bingo.html')

@app.route('/bingo.css')
def styles():
    return send_from_directory('.', 'bingo.css')

@app.route('/bingo.js')
def scripts():
    return send_from_directory('.', 'bingo.js')


# ── Room discovery ────────────────────────

@app.route('/api/rooms', methods=['GET'])
def list_rooms():
    purge_stale_rooms()
    result = []
    for code, room in rooms.items():
        if room.get('public') and room['status'] == 'lobby':
            host = next((p['name'] for p in room['players'] if p['id'] == room['host']), '?')
            result.append({
                'code':        code,
                'hostName':    host,
                'players':     len(room['players']),
                'maxPlayers':  MAX_PLAYERS,
                'gridSize':    room['gridSize'],
                'hasPassword': bool(room.get('password', '')),
            })
    result.sort(key=lambda r: -r['players'])
    return jsonify(result)


@app.route('/api/quickjoin', methods=['POST'])
def quickjoin():
    purge_stale_rooms()
    d   = safe_json()
    pid = str((d or {}).get('id', '')).strip()[:64]

    candidates = [
        (code, room) for code, room in rooms.items()
        if room.get('public')
        and room['status'] == 'lobby'
        and not room.get('password', '')
        and len(room['players']) < MAX_PLAYERS
        and not any(p['id'] == pid for p in room['players'])
    ]
    if not candidates:
        return err('No open rooms available — create one!')
    code, _ = max(candidates, key=lambda x: len(x[1]['players']))
    return jsonify({'code': code})


# ── Room management ───────────────────────

@app.route('/api/room', methods=['POST'])
def create_room():
    purge_stale_rooms()
    if len(rooms) >= MAX_ROOMS:
        return err('Server full — try again later', 503)

    client_ip = request.remote_addr or '0.0.0.0'
    if not _check_ip_rate_limit(client_ip):
        return err(f'Too many rooms created — please wait before creating another', 429)

    d    = safe_json()
    pid  = str((d or {}).get('id',   '')).strip()[:64]
    name = str((d or {}).get('name', '')).strip()[:MAX_NAME]
    if not name or not pid:
        return err('Name and id are required')

    try:
        gs = max(5, min(10, int((d or {}).get('gridSize', 5))))
    except (TypeError, ValueError):
        gs = 5

    is_public = bool((d or {}).get('public', True))
    password  = str((d or {}).get('password', '')).strip()[:50]

    code, tries = gen_code(), 0
    while code in rooms and tries < 100:
        code = gen_code(); tries += 1
    if code in rooms:
        return err('Could not generate unique code', 503)

    rooms[code] = {
        'host':             pid,
        'status':           'lobby',
        'gridSize':         gs,
        'public':           is_public,
        'password':         password,
        'calledNumbers':    [],
        'currentPlayerIdx': 0,
        'players':          [make_player(pid, name, COLORS[0])],
        'rankings':         [],
        'chat':             [],
        'lastActive':       time.time(),
    }
    _record_ip_creation(client_ip)
    return jsonify({'code': code, 'room': _sanitize(rooms[code])})


@app.route('/api/room/<code>/join', methods=['POST'])
def join_room(code):
    code = code.upper()
    room = rooms.get(code)
    if not room:                  return err('Room not found', 404)
    if room['status'] != 'lobby': return err('Game already started')

    d    = safe_json()
    pid  = str((d or {}).get('id',   '')).strip()[:64]
    name = str((d or {}).get('name', '')).strip()[:MAX_NAME]
    pw   = str((d or {}).get('password', '')).strip()

    if not pid or not name:
        return err('Name and id are required')

    existing = next((p for p in room['players'] if p['id'] == pid), None)
    if existing:
        existing['lastSeen'] = time.time()   # refresh presence on reconnect
        touch(room)
        return jsonify({'code': code, 'room': _sanitize(room)})

    if not _check_password(room.get('password', ''), pw):
        return err('Wrong password', 403)

    if len(room['players']) >= MAX_PLAYERS:
        return err(f'Room is full (max {MAX_PLAYERS})')

    color = COLORS[len(room['players']) % len(COLORS)]
    room['players'].append(make_player(pid, name, color))
    touch(room)
    return jsonify({'code': code, 'room': _sanitize(room)})


@app.route('/api/room/<code>', methods=['GET'])
def get_room(code):
    room = rooms.get(code.upper())
    if not room: return err('Room not found', 404)
    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/settings', methods=['POST'])
def update_settings(code):
    room = rooms.get(code.upper())
    if not room:                  return err('Room not found', 404)
    if room['status'] != 'lobby': return err('Lobby only')

    d      = safe_json()
    player = validate_pid(d, room)
    if not player or player['id'] != room['host']:
        return err('Only host can change settings', 403)

    try:
        room['gridSize'] = max(5, min(10, int((d or {}).get('gridSize', room['gridSize']))))
    except (TypeError, ValueError):
        return err('Invalid grid size')

    if 'public'   in (d or {}): room['public']   = bool(d['public'])
    if 'password' in (d or {}): room['password'] = str(d['password']).strip()[:50]

    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/start', methods=['POST'])
def start_game(code):
    room = rooms.get(code.upper())
    if not room:                  return err('Room not found', 404)
    if room['status'] != 'lobby': return err('Already started')

    d      = safe_json()
    player = validate_pid(d, room)
    if not player or player['id'] != room['host']:
        return err('Only host can start', 403)

    if len(room['players']) < 2:
        return err('Need at least 2 players to start')

    room['status'] = 'setup'
    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/submit-card', methods=['POST'])
def submit_card(code):
    room = rooms.get(code.upper())
    if not room:                   return err('Room not found', 404)
    if room['status'] != 'setup': return err('Not setup phase')

    d      = safe_json()
    player = validate_pid(d, room)
    if not player:      return err('Player not found', 404)
    if player['ready']: return err('Card already submitted')

    card = (d or {}).get('card')
    gs   = room['gridSize']
    n    = gs * gs

    if not isinstance(card, list) or len(card) != n:
        return err(f'Card must have exactly {n} numbers')
    try:
        card = [int(x) for x in card]
    except (TypeError, ValueError):
        return err('Card values must be integers')
    if sorted(card) != list(range(1, n + 1)):
        return err(f'Card must contain 1–{n} each exactly once')

    player['card']  = card
    player['ready'] = True
    if all(p['ready'] for p in room['players']):
        room['status']           = 'playing'
        room['currentPlayerIdx'] = 0

    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/call', methods=['POST'])
def call_number(code):
    room = rooms.get(code.upper())
    if not room:                     return err('Room not found', 404)
    if room['status'] != 'playing': return err('Not in progress')

    d      = safe_json()
    player = validate_pid(d, room)
    if not player: return err('Player not found', 404)

    current = room['players'][room['currentPlayerIdx']]
    if current['id'] != player['id']: return err('Not your turn', 403)
    if player['rank'] is not None:
        room['currentPlayerIdx'] = next_active_idx(room)
        return err('Already ranked', 403)

    try:
        number = int((d or {}).get('number', 0))
    except (TypeError, ValueError):
        return err('Invalid number')

    gs_max = room['gridSize'] ** 2
    if number < 1 or number > gs_max: return err(f'Must be 1–{gs_max}')
    if number in room['calledNumbers']: return err('Already called')

    room['calledNumbers'].append(number)
    room['currentPlayerIdx'] = next_active_idx(room)
    if len(room['calledNumbers']) == gs_max:
        _finalize(room)

    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/mark', methods=['POST'])
def mark_number(code):
    room = rooms.get(code.upper())
    if not room: return err('Room not found', 404)
    if room['status'] not in ('playing', 'ended'): return err('Not in progress')

    d      = safe_json()
    player = validate_pid(d, room)
    if not player: return err('Player not found', 404)

    try:
        number = int((d or {}).get('number', 0))
    except (TypeError, ValueError):
        return err('Invalid number')

    if number not in room['calledNumbers']:       return err('Not called yet')
    if not player['card'] or number not in player['card']: return err('Not on your card')

    if number not in player['markedNumbers']:
        player['markedNumbers'].append(number)
        lines              = count_lines(player['card'], player['markedNumbers'], room['gridSize'])
        player['bingoLines'] = lines
        if lines >= 5 and player['rank'] is None:
            player['rank'] = len(room['rankings']) + 1
            room['rankings'].append({'id':player['id'],'name':player['name'],
                                     'color':player['color'],'rank':player['rank'],
                                     'bingoLines':lines})
            if all(p['rank'] is not None for p in room['players']):
                room['status'] = 'ended'

    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/chat', methods=['POST'])
def send_chat(code):
    room = rooms.get(code.upper())
    if not room: return err('Room not found', 404)

    d      = safe_json()
    player = validate_pid(d, room)
    if not player: return err('Join the room first', 403)

    msg = str((d or {}).get('message', '')).strip()[:200]
    if not msg: return err('Empty message')

    room['chat'].append({'name':player['name'],'color':player['color'],
                         'message':msg,'t':int(time.time())})
    room['chat'] = room['chat'][-60:]
    touch(room)
    return jsonify({'ok': True})


@app.route('/api/room/<code>/heartbeat', methods=['POST'])
def heartbeat(code):
    """Lightweight presence ping — keeps player marked as online."""
    room = rooms.get(code.upper())
    if not room:
        return jsonify({'ok': False})
    d      = safe_json()
    player = validate_pid(d, room)   # updates lastSeen as a side-effect
    if player:
        touch(room)
    return jsonify({'ok': True})


@app.route('/api/room/<code>/kick', methods=['POST'])
def kick_player(code):
    """Host removes a player from the lobby."""
    code = code.upper()
    room = rooms.get(code)
    if not room:                  return err('Room not found', 404)
    if room['status'] != 'lobby': return err('Can only kick players in the lobby')

    d      = safe_json()
    player = validate_pid(d, room)
    if not player or player['id'] != room['host']:
        return err('Only the host can kick players', 403)

    target_id = str((d or {}).get('targetId', '')).strip()[:64]
    if not target_id:             return err('targetId required')
    if target_id == room['host']: return err('Cannot kick the host')

    before = len(room['players'])
    room['players'] = [p for p in room['players'] if p['id'] != target_id]
    if len(room['players']) == before:
        return err('Player not found', 404)

    touch(room)
    return jsonify(_sanitize(room))


@app.route('/api/room/<code>/leave', methods=['POST'])
def leave_room(code):
    """Player voluntarily leaves a room."""
    code = code.upper()
    room = rooms.get(code)
    if not room:
        return jsonify({'ok': True})   # already gone — success

    d   = safe_json()
    pid = str((d or {}).get('id', '')).strip()[:64]

    if pid == room['host']:
        # Host leaving ALWAYS destroys the room regardless of game status.
        # All other players will get a 404 on their next poll and be sent
        # back to the main menu automatically.
        del rooms[code]
        return jsonify({'ok': True, 'deleted': True})

    # Non-host leaving
    if room['status'] == 'lobby':
        room['players'] = [p for p in room['players'] if p['id'] != pid]
        if not room['players']:
            del rooms[code]
        else:
            touch(room)
    # In setup/playing/ended: non-host just goes offline naturally.
    # Removing them mid-game would corrupt turn order and card state.
    return jsonify({'ok': True})


@app.route('/api/room/<code>/reset', methods=['POST'])
def reset_room(code):
    room = rooms.get(code.upper())
    if not room: return err('Room not found', 404)

    d      = safe_json()
    player = validate_pid(d, room)
    if not player or player['id'] != room['host']:
        return err('Only host can reset', 403)

    for p in room['players']:
        p.update({'card':None,'ready':False,'markedNumbers':[],'bingoLines':0,'rank':None})
    room.update({'calledNumbers':[],'currentPlayerIdx':0,'rankings':[],'status':'lobby','chat':[]})
    touch(room)
    return jsonify(_sanitize(room))


if __name__ == '__main__':
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]; s.close()
    except Exception:
        ip = '127.0.0.1'
    print(f'\n╔══════════════════════════════════════╗')
    print(f'║   🎱  BINGO SERVER RUNNING           ║')
    print(f'║   Local:   http://localhost:5000     ║')
    print(f'║   Network: http://{ip}:5000  ║')
    print(f'╚══════════════════════════════════════╝\n')
    app.run(host='0.0.0.0', port=5000, debug=False)
