"use strict";
/**
 * Flight route plausibility & airport bearing math ported from upstream
 * src/data/routePlausible.js and src/ui/cockpitInstruments.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EARTH_RADIUS_KM = void 0;
exports.greatCircleKmBetween = greatCircleKmBetween;
exports.bearingBetweenDeg = bearingBetweenDeg;
exports.relativeBearingDeg = relativeBearingDeg;
exports.crossTrackKm = crossTrackKm;
exports.routePlausible = routePlausible;
exports.EARTH_RADIUS_KM = 6_371.0088;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
function isGeoPoint(pt) {
    return (!!pt &&
        typeof pt.lat === 'number' &&
        typeof pt.lon === 'number' &&
        Number.isFinite(pt.lat) &&
        Number.isFinite(pt.lon) &&
        Math.abs(pt.lat) <= 90 &&
        Math.abs(pt.lon) <= 180);
}
function greatCircleKmBetween(a, b) {
    const p1 = a.lat * D2R;
    const p2 = b.lat * D2R;
    const dLat = (b.lat - a.lat) * D2R;
    const dLon = (b.lon - a.lon) * D2R;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * exports.EARTH_RADIUS_KM * Math.atan2(Math.sqrt(s), Math.sqrt(Math.max(0, 1 - s)));
}
function bearingRad(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R;
    const p2 = lat2 * D2R;
    const dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return Math.atan2(y, x);
}
function bearingBetweenDeg(lat1, lon1, lat2, lon2) {
    const deg = bearingRad(lat1, lon1, lat2, lon2) * R2D;
    return ((deg % 360) + 360) % 360;
}
function relativeBearingDeg(targetBearingDeg, headingDeg) {
    return ((((targetBearingDeg - headingDeg) % 360) + 540) % 360) - 180;
}
function crossTrackKm(lat, lon, lat1, lon1, lat2, lon2) {
    const d13 = greatCircleKmBetween({ lat: lat1, lon: lon1 }, { lat, lon }) / exports.EARTH_RADIUS_KM;
    const b13 = bearingRad(lat1, lon1, lat, lon);
    const b12 = bearingRad(lat1, lon1, lat2, lon2);
    return Math.asin(Math.sin(d13) * Math.sin(b13 - b12)) * exports.EARTH_RADIUS_KM;
}
function alongTrackKm(position, origin, destination) {
    const distance = greatCircleKmBetween(origin, position) / exports.EARTH_RADIUS_KM;
    const direction = bearingRad(origin.lat, origin.lon, position.lat, position.lon) -
        bearingRad(origin.lat, origin.lon, destination.lat, destination.lon);
    return (Math.atan2(Math.sin(distance) * Math.cos(direction), Math.cos(distance)) *
        exports.EARTH_RADIUS_KM);
}
const NEAR_ENDPOINT_KM = 130;
const CROSS_TRACK_KM = 200;
const CROSS_TRACK_ROUTE_FRACTION = 0.15;
const LOW_ALT_M = 3700;
const VERT_TREND_MPS = 2;
const LOCAL_AIRPORT_KM = 150;
function routePlausible(params) {
    const position = { lat: params.latDeg, lon: params.lonDeg };
    if (!isGeoPoint(position))
        return true;
    const origin = isGeoPoint(params.origin) ? params.origin : null;
    const destination = isGeoPoint(params.destination) ? params.destination : null;
    if (!origin && !destination)
        return true;
    const near = (pt) => greatCircleKmBetween(position, pt) < NEAR_ENDPOINT_KM;
    let geomOk = (origin ? near(origin) : false) || (destination ? near(destination) : false);
    if (!geomOk && origin && destination) {
        const routeKm = greatCircleKmBetween(origin, destination);
        const alongKm = alongTrackKm(position, origin, destination);
        const segmentAlongKm = alongKm < -CROSS_TRACK_KM ? alongKm + 2 * Math.PI * exports.EARTH_RADIUS_KM : alongKm;
        const segmentKnown = routeKm > 0.001 && routeKm < Math.PI * exports.EARTH_RADIUS_KM - 0.001;
        const corridorKm = segmentKnown
            ? Math.max(CROSS_TRACK_KM, CROSS_TRACK_ROUTE_FRACTION * routeKm)
            : CROSS_TRACK_KM;
        geomOk =
            Math.abs(crossTrackKm(params.latDeg, params.lonDeg, origin.lat, origin.lon, destination.lat, destination.lon)) < corridorKm &&
                (!segmentKnown ||
                    (segmentAlongKm >= -CROSS_TRACK_KM && segmentAlongKm <= routeKm + CROSS_TRACK_KM));
    }
    else if (!geomOk) {
        geomOk = true;
    }
    if (!geomOk)
        return false;
    if (params.altitudeM != null &&
        Number.isFinite(params.altitudeM) &&
        params.altitudeM < LOW_ALT_M &&
        params.verticalRateMps != null &&
        Number.isFinite(params.verticalRateMps) &&
        Math.abs(params.verticalRateMps) > VERT_TREND_MPS) {
        if (params.verticalRateMps > 0) {
            if (origin && greatCircleKmBetween(position, origin) > LOCAL_AIRPORT_KM)
                return false;
        }
        else if (destination && greatCircleKmBetween(position, destination) > LOCAL_AIRPORT_KM) {
            return false;
        }
    }
    return true;
}
