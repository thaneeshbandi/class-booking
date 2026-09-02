import { api } from './client.js';

export const fetchRooms = () => api.get('/api/rooms');
