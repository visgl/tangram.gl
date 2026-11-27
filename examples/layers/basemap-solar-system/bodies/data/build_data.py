# Builds data/<body>.geojson of the solar-system example from open planetary data (see README.md).
# Needs Python 3 and GDAL (ogr2ogr with SQLite/SpatiaLite).
# Run: python3 -I build_data.py <reduced-sources-dir> <gazetteer-dir> <out-dir>
import json, math, os, re, subprocess, sys, collections, tempfile

RES, GAZ, OUT = sys.argv[1:4]
RADIUS_KM = {'moon': 1737.4, 'mars': 3396.19, 'mercury': 2439.4, 'venus': 6051.8}
MAX_LAT = 84.0


def wrap(lon):
    lon = ((lon + 180) % 360) - 180
    return lon


def rnd(coords, nd):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]
    return [rnd(c, nd) for c in coords]


def lon_span(coords):
    xs = []
    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0])
        else:
            for k in c:
                walk(k)
    walk(coords)
    return max(xs) - min(xs), max(abs(c) for c in xs)


def lat_max(coords):
    ys = []
    def walk(c):
        if isinstance(c[0], (int, float)):
            ys.append(abs(c[1]))
        else:
            for k in c:
                walk(k)
    walk(coords)
    return max(ys)


def ok_geometry(g):
    """Drops geometry that crosses the antimeridian (jumps of > 180 deg) or reaches the poles."""
    span, _ = lon_span(g['coordinates'])
    return span < 180 and lat_max(g['coordinates']) <= MAX_LAT


def circle(lon, lat, diameter_km, radius_km, n=48):
    a = diameter_km / 2 / radius_km
    la, lo = math.radians(lat), math.radians(lon)
    pts = []
    for k in range(n + 1):
        b = 2 * math.pi * (k % n) / n
        lat2 = math.asin(math.sin(la) * math.cos(a) + math.cos(la) * math.sin(a) * math.cos(b))
        lon2 = lo + math.atan2(math.sin(b) * math.sin(a) * math.cos(la), math.cos(a) - math.sin(la) * math.sin(lat2))
        pts.append([math.degrees(lon2), math.degrees(lat2)])
    return {'type': 'LineString', 'coordinates': pts}


def gazetteer(body, min_names, min_crater_km, crater_rings):
    src = json.load(open(f'{GAZ}/{body.upper()}.geojson'))['features']
    names, craters = [], []
    for f in src:
        p = f['properties']
        if p.get('approval') != 'Adopted by IAU' or p['code'] == 'SF':
            continue
        d = p.get('diameter') or 0
        lon, lat = wrap(p['center_lon']), p['center_lat']
        if d >= min_names and abs(lat) <= MAX_LAT:
            names.append({'type': 'Feature', 'properties': {'kind': 'name', 'name': p['clean_name'], 'diameter_km': round(d, 1), 'code': p['code']},
                          'geometry': {'type': 'Point', 'coordinates': [round(lon, 3), round(lat, 3)]}})
        if crater_rings and p['code'] == 'AA' and d >= min_crater_km:
            g = circle(lon, lat, d, RADIUS_KM[body])
            if ok_geometry(g):
                craters.append({'type': 'Feature', 'properties': {'kind': 'crater'}, 'geometry': {**g, 'coordinates': rnd(g['coordinates'], 3)}})
    return names, craters


def load(path):
    d = json.load(open(path))
    if d['type'] == 'GeometryCollection':
        return [{'type': 'Feature', 'properties': {}, 'geometry': g} for g in d['geometries']]
    return [f for f in d['features'] if f.get('geometry')]


def explode_polygons(g):
    if g['type'] == 'Polygon':
        return [g]
    if g['type'] == 'MultiPolygon':
        return [{'type': 'Polygon', 'coordinates': c} for c in g['coordinates']]
    return []


def npts(c):
    return 1 if isinstance(c[0], (int, float)) else sum(npts(k) for k in c)


SIMPLIFY_DEG = {'moon': 0.02, 'mars': 0.06, 'mercury': 0.04, 'venus': 0.04}


def write(body, features):
    """Writes <body>.geojson: Douglas-Peucker simplification (ogr2ogr), 2 or 3 decimals."""
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = os.path.join(tmp, 'in.geojson'), os.path.join(tmp, 'out.geojson')
        json.dump({'type': 'FeatureCollection', 'features': features}, open(src, 'w'))
        subprocess.run(['ogr2ogr', '-f', 'GeoJSON', '-simplify', str(SIMPLIFY_DEG[body]), '-lco', 'RFC7946=NO', dst, src],
                       check=True, stderr=subprocess.DEVNULL)
        simplified = load(dst)
    out = []
    for f in simplified:
        g = f['geometry']
        nd = 3 if f['properties']['kind'] in ('name', 'crater', 'ring') else 2
        g['coordinates'] = rnd(g['coordinates'], nd)
        if g['type'] == 'Polygon' and npts(g['coordinates']) < 6:
            continue
        out.append({'type': 'Feature', 'properties': {k: v for k, v in f['properties'].items() if v is not None}, 'geometry': g})
    text = json.dumps({'type': 'FeatureCollection', 'features': out}, separators=(',', ':'), ensure_ascii=False)
    open(f'{OUT}/{body}.geojson', 'w').write(text)
    print(body, len(text), dict(collections.Counter(f['properties']['kind'] for f in out)))


# Moon: USGS Unified Geologic Map of the Moon (CC0): mare outlines, crater rim crests and basin
# rings; IAU/USGS gazetteer names.
moon = []
for f in load(f'{RES}/moon/mare_1pct.geojson'):
    for g in explode_polygons(f['geometry']):
        if ok_geometry(g):
            moon.append({'type': 'Feature', 'properties': {'kind': 'unit', 'unit': 'mare'}, 'geometry': {**g, 'coordinates': rnd(g['coordinates'], 2)}})
for f in load(f'{RES}/moon/crater_rims_basin_rings.geojson'):
    g = f['geometry']
    if ok_geometry(g):
        kind = 'ring' if f['properties']['TYPE'] == 'basin ring' else 'crater'
        moon.append({'type': 'Feature', 'properties': {'kind': kind}, 'geometry': {**g, 'coordinates': rnd(g['coordinates'], 3)}})
names, _ = gazetteer('moon', 40, 0, False)
write('moon', moon + names)

# Mars: USGS SIM 3292 global geologic map (public domain): units by age; gazetteer names and
# crater rims from the gazetteer centres and diameters.
mars = []
by_age = []
for f in load(f'{RES}/mars/units_1pct.geojson'):
    unit = f['properties']['unit']
    m = re.search(r'[NHA]', unit)
    age = {'N': 'noachian', 'H': 'hesperian', 'A': 'amazonian'}[m.group(0)] if m else 'other'
    by_age.append({'type': 'Feature', 'properties': {'unit': age}, 'geometry': f['geometry']})
# Dissolve the units of one age into one geometry: the shared edges go, and the file halves.
with tempfile.TemporaryDirectory() as tmp:
    src, dst = os.path.join(tmp, 'units.geojson'), os.path.join(tmp, 'dissolved.geojson')
    json.dump({'type': 'FeatureCollection', 'features': by_age}, open(src, 'w'))
    subprocess.run(['ogr2ogr', '-f', 'GeoJSON', '-dialect', 'sqlite', '-sql',
                    'SELECT unit, ST_Union(ST_MakeValid(geometry)) AS geometry FROM units GROUP BY unit',
                    dst, src], check=True, stderr=subprocess.DEVNULL)
    for f in load(dst):
        for g in explode_polygons(f['geometry']):
            if ok_geometry(g):
                mars.append({'type': 'Feature', 'properties': {'kind': 'unit', 'unit': f['properties']['unit']}, 'geometry': {**g, 'coordinates': rnd(g['coordinates'], 2)}})
names, craters = gazetteer('mars', 60, 60, True)
write('mars', mars + craters + names)

# Mercury: contours from the USGS MESSENGER global DEM (665 m, v2); gazetteer names and crater
# rims.
mercury = []
for f in load(f'{RES}/mercury/merc_contours_2km_small.geojson'):
    g = f['geometry']
    lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
    # Every 4 km, and no line shorter than 150 km.
    if f['properties']['len'] < 150000 or f['properties']['elev'] % 4000:
        continue
    for c in lines:
        if len(c) < 4:
            continue
        lg = {'type': 'LineString', 'coordinates': rnd(c, 2)}
        if ok_geometry(lg):
            mercury.append({'type': 'Feature', 'properties': {'kind': 'contour', 'elevation_m': f['properties']['elev']}, 'geometry': lg})
names, craters = gazetteer('mercury', 40, 60, True)
write('mercury', mercury + craters + names)

# Venus: gazetteer names and crater rims only.
names, craters = gazetteer('venus', 60, 30, True)
write('venus', craters + names)
