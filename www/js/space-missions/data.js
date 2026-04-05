export const MISSIONS = {};

export function getMission(id) {
    return MISSIONS[id] || null;
}

export function getAllMissions() {
    return Object.values(MISSIONS);
}

export function addMission(id, mission) {
    MISSIONS[id] = { id, ...mission };
}