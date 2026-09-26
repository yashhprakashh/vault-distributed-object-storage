import { useState, useEffect, useReducer, useContext, createContext, useRef } from 'react';
import {
    Server, Database, ShieldCheck, Settings,
    PlayCircle, CheckCircle, AlertTriangle, XCircle,
    Network, ArrowRight, ActivitySquare, FileText,
    FileWarning, BarChart3, Clock, UploadCloud, Info
} from 'lucide-react';
import {
    PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip
} from 'recharts';

// --- Constants & Utilities ---

const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const deterministicHash = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; 
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return hex.repeat(8).substring(0, 64); // mock 64-char sample hash
};

async function generateRealChecksum(file) {
    try {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return deterministicHash(file.name + Date.now());
    }
}

// --- Initial Data ---

const MOCK_NODES = Array.from({ length: 6 }, (_, i) => ({
    id: `NODE-0${i + 1}`,
    status: 'ONLINE',
    capacity: 100 * 1024 * 1024 * 1024, 
    used: 10 * 1024 * 1024 * 1024, 
    objectsStored: 0,
    cpu: Math.floor(Math.random() * 20) + 10,
    memory: Math.floor(Math.random() * 40) + 20,
    latency: Math.floor(Math.random() * 15) + 5,
    lastHeartbeat: Date.now()
}));

const SAMPLE_FILES = [
    { name: 'customer-records.db', size: 1.2 * 1024 * 1024 * 1024 },
    { name: 'research-data.zip', size: 4.5 * 1024 * 1024 * 1024 },
    { name: 'video-archive.mp4', size: 8.4 * 1024 * 1024 * 1024 },
    { name: 'analytics.parquet', size: 500 * 1024 * 1024 },
    { name: 'sensor-data.csv', size: 2.1 * 1024 * 1024 * 1024 }
];

const initialObjects = SAMPLE_FILES.map((file, i) => ({
    id: `obj-00${i + 1}`,
    name: file.name,
    size: file.size,
    checksum: deterministicHash(file.name),
    version: 1,
    status: 'HEALTHY',
    createdAt: Date.now() - Math.random() * 10000000,
    lastVerified: Date.now()
}));

const initialReplicas = [];
initialObjects.forEach(obj => {
    const nodes = [...MOCK_NODES].sort(() => 0.5 - Math.random()).slice(0, 3);
    nodes.forEach(node => {
        initialReplicas.push({
            id: `rep-${obj.id}-${node.id}`,
            objectId: obj.id,
            nodeId: node.id,
            status: 'HEALTHY',
            checksum: obj.checksum,
            version: 1,
            createdAt: obj.createdAt,
            lastVerified: obj.lastVerified
        });
    });
});

const initialState = {
    nodes: MOCK_NODES,
    objects: initialObjects,
    replicas: initialReplicas,
    jobs: [],
    events: [{ id: Date.now(), timestamp: Date.now(), type: 'SYSTEM_START', message: 'Vault distributed storage initialized.', severity: 'info' }],
    operations: [],
    settings: {
        rf: 3,
        durability: 'Standard',
        autoRepair: true,
        autoRebalance: true,
        writeQuorum: 'MAJORITY'
    },
    lastRecoveryTime: null,
    demoActive: false
};

// --- Reducer ---

function vaultReducer(state, action) {
    switch (action.type) {
        case 'TICK': {
            if (state.demoActive && !action.payload?.allowTick) return state;

            let updatedJobs = [...state.jobs];
            let updatedReplicas = [...state.replicas];
            let updatedObjects = [...state.objects];
            let updatedNodes = [...state.nodes];
            let newEvents = [];
            
            // 1. Process Jobs
            updatedJobs = updatedJobs.map(job => {
                if (job.status !== 'QUEUED' && job.status !== 'REPAIRING' && job.status !== 'IN_PROGRESS' && job.status !== 'SYNCING') return job;

                const newProgress = Math.min(100, job.progress + (Math.random() * 10 + 10));

                if (newProgress === 100) {
                    if (job.type === 'REPAIR') {
                        const targetNode = updatedNodes.find(n => n.id === job.targetNode);
                        const obj = updatedObjects.find(o => o.id === job.objectId);

                        // Validate target
                        if (!targetNode || targetNode.status !== 'ONLINE') {
                            newEvents.push({ id: Date.now(), timestamp: Date.now(), type: 'REPAIR_FAILED', message: `Repair failed: Target node ${job.targetNode} is offline.`, severity: 'error' });
                            return { ...job, status: 'FAILED', progress: 0 };
                        }

                        // Check duplicate
                        if (updatedReplicas.find(r => r.objectId === job.objectId && r.nodeId === job.targetNode)) {
                            return { ...job, status: 'FAILED' };
                        }

                        // Execute repair
                        updatedReplicas.push({
                            id: `rep-${obj.id}-${job.targetNode}-${Date.now()}`,
                            objectId: obj.id,
                            nodeId: job.targetNode,
                            status: 'HEALTHY',
                            checksum: obj.checksum,
                            version: obj.version,
                            createdAt: Date.now(),
                            lastVerified: Date.now()
                        });
                        
                        // Clean old failed replica if present
                        if (job.failedNode) {
                             updatedReplicas = updatedReplicas.filter(r => !(r.objectId === job.objectId && r.nodeId === job.failedNode));
                        }

                        newEvents.push({ id: Date.now(), timestamp: Date.now(), type: 'REPAIR_COMPLETED', message: `Rebuilt ${obj.name} replica on ${job.targetNode}`, severity: 'success' });
                        return { ...job, status: 'COMPLETED', progress: 100, endTime: Date.now() };
                    }

                    if (job.type === 'REBALANCE') {
                        const obj = updatedObjects.find(o => o.id === job.objectId);
                        let objectReplicas = updatedReplicas.filter(r => r.objectId === obj.id);

                        if (objectReplicas.length > job.targetRf) {
                            // REDUCE RF: prioritize bad replicas
                            const sortOrder = { UNAVAILABLE: 1, CORRUPTED: 2, STALE: 3, SYNCING: 4, HEALTHY: 5 };
                            objectReplicas.sort((a, b) => sortOrder[a.status] - sortOrder[b.status]);
                            
                            const toRemoveCount = objectReplicas.length - job.targetRf;
                            const removedIds = objectReplicas.slice(0, toRemoveCount).map(r => r.id);
                            updatedReplicas = updatedReplicas.filter(r => !removedIds.includes(r.id));
                            newEvents.push({ id: Date.now(), timestamp: Date.now(), type: 'REBALANCING_COMPLETED', message: `Removed excess replicas for ${obj.name}`, severity: 'info' });
                        } else if (objectReplicas.length < job.targetRf) {
                            // INCREASE RF
                            const toAdd = job.targetRf - objectReplicas.length;
                            const existingNodeIds = objectReplicas.map(r => r.nodeId);
                            const eligibleNodes = updatedNodes.filter(n => n.status === 'ONLINE' && !existingNodeIds.includes(n.id));

                            for (let i = 0; i < Math.min(toAdd, eligibleNodes.length); i++) {
                                updatedReplicas.push({
                                    id: `rep-${obj.id}-${eligibleNodes[i].id}-${Date.now()}`,
                                    objectId: obj.id,
                                    nodeId: eligibleNodes[i].id,
                                    status: 'HEALTHY',
                                    checksum: obj.checksum,
                                    version: obj.version,
                                    createdAt: Date.now(),
                                    lastVerified: Date.now()
                                });
                            }
                            newEvents.push({ id: Date.now(), timestamp: Date.now(), type: 'REBALANCING_COMPLETED', message: `Added new replicas for ${obj.name}`, severity: 'success' });
                        }
                        return { ...job, status: 'COMPLETED', progress: 100, endTime: Date.now() };
                    }
                }
                return { ...job, progress: newProgress, status: job.status === 'QUEUED' ? 'IN_PROGRESS' : job.status };
            });

            // 2. Process Syncing Replicas
            updatedReplicas = updatedReplicas.map(rep => {
                if (rep.status === 'SYNCING') {
                    if (Math.random() > 0.6) { // Simulate sync completion
                        return { ...rep, status: 'HEALTHY', lastVerified: Date.now() };
                    }
                }
                return rep;
            });

            // 3. Update Node Metrics & Storage
            const baseStorage = 10 * 1024 * 1024 * 1024; // 10GB OS overhead
            updatedNodes = updatedNodes.map(node => {
                if (node.status === 'OFFLINE') return node;
                
                // CPU/Mem wobble
                const cpu = Math.max(5, Math.min(95, node.cpu + (Math.random() * 10 - 5)));
                const latency = Math.max(2, Math.min(100, node.latency + (Math.random() * 4 - 2)));
                
                // Exact storage calculation based on hosted replicas
                const activeReplicas = updatedReplicas.filter(r => r.nodeId === node.id && r.status !== 'UNAVAILABLE');
                const storedBytes = activeReplicas.reduce((acc, rep) => {
                    const o = updatedObjects.find(obj => obj.id === rep.objectId);
                    return acc + (o ? o.size : 0);
                }, 0);

                return {
                    ...node,
                    cpu: Math.floor(cpu),
                    latency: Math.floor(latency),
                    lastHeartbeat: Date.now(),
                    used: baseStorage + storedBytes,
                    objectsStored: activeReplicas.length
                };
            });

            // 4. Auto-Repair Trigger (if enabled)
            if (state.settings.autoRepair && !state.demoActive) {
                updatedObjects.forEach(obj => {
                    const reps = updatedReplicas.filter(r => r.objectId === obj.id);
                    const healthyCount = reps.filter(r => r.status === 'HEALTHY' || r.status === 'SYNCING').length;
                    
                    if (healthyCount < state.settings.rf && healthyCount > 0) {
                        const badRep = reps.find(r => r.status === 'UNAVAILABLE' || r.status === 'CORRUPTED');
                        if (badRep) {
                            // Check for existing repair job
                            const activeRepair = updatedJobs.find(j => j.objectId === obj.id && j.type === 'REPAIR' && (j.status === 'QUEUED' || j.status === 'IN_PROGRESS' || j.status === 'REPAIRING'));
                            if (!activeRepair) {
                                const eligibleNodes = updatedNodes.filter(n => n.status === 'ONLINE' && !reps.some(r => r.nodeId === n.id));
                                if (eligibleNodes.length > 0) {
                                    const targetNode = eligibleNodes[0].id;
                                    updatedJobs.push({
                                        id: `repair-${Date.now()}`,
                                        type: 'REPAIR',
                                        objectId: obj.id,
                                        failedNode: badRep.nodeId,
                                        targetNode,
                                        progress: 0,
                                        status: 'QUEUED',
                                        startTime: Date.now()
                                    });
                                    newEvents.push({ id: Date.now(), timestamp: Date.now(), type: 'REPAIR_STARTED', message: `Auto-repair triggered for ${obj.name}`, severity: 'warning' });
                                }
                            }
                        }
                    }
                });
            }

            // 4.1 Auto-Rebalance Trigger (Clean up excess replicas automatically if enabled)
            if (state.settings.autoRebalance && !state.demoActive) {
                updatedObjects.forEach(obj => {
                    const objectReplicas = updatedReplicas.filter(r => r.objectId === obj.id);
                    if (objectReplicas.length > state.settings.rf) {
                        const activeRebalance = updatedJobs.find(j => j.objectId === obj.id && j.type === 'REBALANCE' && j.status !== 'COMPLETED');
                        if (!activeRebalance) {
                            updatedJobs.push({
                                id: `rebal-${obj.id}-${Date.now()}`,
                                type: 'REBALANCE',
                                objectId: obj.id,
                                targetRf: state.settings.rf,
                                progress: 0,
                                status: 'QUEUED',
                                startTime: Date.now()
                            });
                        }
                    }
                });
            }

            // 5. Evaluate Object Status
            updatedObjects = updatedObjects.map(obj => {
                const reps = updatedReplicas.filter(r => r.objectId === obj.id);
                const activeCount = reps.filter(r => r.status === 'HEALTHY' || r.status === 'SYNCING').length;
                
                let status = 'HEALTHY';
                if (activeCount === 0) status = 'UNAVAILABLE';
                else if (activeCount < state.settings.rf) status = 'DEGRADED';
                
                if (reps.some(r => r.status === 'CORRUPTED')) status = 'CORRUPTED';
                if (reps.some(r => r.status === 'STALE')) status = 'DEGRADED';

                return { ...obj, status };
            });

            // 6. Recovery Time
            const recentRepairs = updatedJobs.filter(j => j.type === 'REPAIR' && j.status === 'COMPLETED' && j.endTime && j.startTime);
            const lastRecoveryTime = recentRepairs.length > 0 
                ? (recentRepairs[recentRepairs.length - 1].endTime - recentRepairs[recentRepairs.length - 1].startTime) / 1000 
                : state.lastRecoveryTime;

            return {
                ...state,
                jobs: updatedJobs,
                replicas: updatedReplicas,
                objects: updatedObjects,
                nodes: updatedNodes,
                events: [...newEvents, ...state.events].slice(0, 150),
                lastRecoveryTime
            };
        }

        case 'FAIL_NODE': {
            const nodeId = action.payload;
            const updatedNodes = state.nodes.map(n => n.id === nodeId ? { ...n, status: 'OFFLINE', cpu: 0, latency: 0 } : n);
            const updatedReplicas = state.replicas.map(r => r.nodeId === nodeId ? { ...r, status: 'UNAVAILABLE' } : r);
            return {
                ...state,
                nodes: updatedNodes,
                replicas: updatedReplicas,
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'NODE_FAILURE', message: `${nodeId} went offline unexpectedly.`, severity: 'error' }, ...state.events].slice(0, 150)
            };
        }

        case 'PARTITION_NODE': {
            const nodeId = action.payload;
            const updatedNodes = state.nodes.map(n => n.id === nodeId ? { ...n, status: 'PARTITIONED', latency: 999 } : n);
            const updatedReplicas = state.replicas.map(r => r.nodeId === nodeId ? { ...r, status: 'UNAVAILABLE' } : r);
            return {
                ...state,
                nodes: updatedNodes,
                replicas: updatedReplicas,
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'NETWORK_PARTITION', message: `${nodeId} isolated due to network partition.`, severity: 'warning' }, ...state.events].slice(0, 150)
            };
        }

        case 'RECOVER_NODE': {
            const nodeId = action.payload;
            const updatedNodes = state.nodes.map(n => n.id === nodeId ? { ...n, status: 'ONLINE', latency: 10, cpu: 15 } : n);
            const updatedReplicas = state.replicas.map(r => (r.nodeId === nodeId && r.status === 'UNAVAILABLE') ? { ...r, status: 'SYNCING' } : r);
            return {
                ...state,
                nodes: updatedNodes,
                replicas: updatedReplicas,
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'NODE_RECOVERED', message: `${nodeId} is back online. Syncing replicas...`, severity: 'info' }, ...state.events].slice(0, 150)
            };
        }

        case 'CORRUPT_REPLICA': {
            const { objectId } = action.payload;
            const healthyReps = state.replicas.filter(r => r.objectId === objectId && r.status === 'HEALTHY');
            if (healthyReps.length === 0) return state;
            const target = healthyReps[Math.floor(Math.random() * healthyReps.length)];
            
            const updatedReplicas = state.replicas.map(r => r.id === target.id ? { ...r, status: 'CORRUPTED', checksum: deterministicHash('corrupt' + Date.now()) } : r);
            return {
                ...state,
                replicas: updatedReplicas,
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'DATA_CORRUPTION', message: `Bit rot simulated on ${target.nodeId}`, severity: 'error' }, ...state.events].slice(0, 150)
            };
        }

        case 'VERIFY_OBJECT': {
            const { objectId } = action.payload;
            const obj = state.objects.find(o => o.id === objectId);
            
            let anyCorrupt = false;
            let anyStale = false;

            const updatedReplicas = state.replicas.map(r => {
                if (r.objectId === objectId && r.status !== 'UNAVAILABLE') {
                    if (r.checksum !== obj.checksum) {
                        anyCorrupt = true;
                        return { ...r, status: 'CORRUPTED', lastVerified: Date.now() };
                    }
                    if (r.version !== obj.version) {
                        anyStale = true;
                        return { ...r, status: 'STALE', lastVerified: Date.now() };
                    }
                    return { ...r, status: 'HEALTHY', lastVerified: Date.now() };
                }
                return r;
            });

            const updatedObjects = state.objects.map(o => o.id === objectId ? { ...o, lastVerified: Date.now() } : o);

            const status = anyCorrupt ? 'FAILED' : (anyStale ? 'WARNING' : 'SUCCESS');
            const newOp = { id: `op-${Date.now()}`, type: 'VERIFY', objectId, node: 'ALL', status, latency: Math.floor(Math.random() * 20) + 10, timestamp: Date.now() };

            return {
                ...state,
                replicas: updatedReplicas,
                objects: updatedObjects,
                operations: [newOp, ...state.operations].slice(0, 50),
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'INTEGRITY_VERIFIED', message: `Verified ${obj.name}: ${status}`, severity: anyCorrupt ? 'error' : 'info' }, ...state.events].slice(0, 150)
            };
        }

        case 'RECONCILE_METADATA': {
            const { replicaId } = action.payload;
            const replica = state.replicas.find(r => r.id === replicaId);
            const obj = state.objects.find(o => o.id === replica.objectId);
            
            const updatedReplicas = state.replicas.map(r => r.id === replicaId ? { ...r, version: obj.version, status: 'HEALTHY', lastVerified: Date.now() } : r);
            
            return {
                ...state,
                replicas: updatedReplicas,
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'METADATA_RECONCILED', message: `Synchronized version metadata for ${obj.name} on ${replica.nodeId}`, severity: 'success' }, ...state.events].slice(0, 150)
            };
        }

        case 'UPDATE_SETTINGS': {
            const newSettings = { ...state.settings, ...action.payload };
            let updatedJobs = [...state.jobs];

            if (action.payload.rf !== undefined && action.payload.rf !== state.settings.rf) {
                const targetRf = action.payload.rf;
                state.objects.forEach(obj => {
                    // Prevent duplicate rebalance jobs
                    if (!updatedJobs.find(j => j.objectId === obj.id && j.type === 'REBALANCE' && j.status !== 'COMPLETED')) {
                        updatedJobs.push({
                            id: `rebal-${obj.id}-${Date.now()}`,
                            type: 'REBALANCE',
                            objectId: obj.id,
                            targetRf,
                            progress: 0,
                            status: 'QUEUED',
                            startTime: Date.now()
                        });
                    }
                });
            }
            return { ...state, settings: newSettings, jobs: updatedJobs };
        }

        case 'SIMULATE_READ': {
            const { objectId } = action.payload;
            const reps = state.replicas.filter(r => r.objectId === objectId && r.status === 'HEALTHY');
            const validNodes = reps.map(r => {
                const n = state.nodes.find(node => node.id === r.nodeId && node.status === 'ONLINE');
                return n ? { node: n, rep: r } : null;
            }).filter(Boolean).sort((a, b) => a.node.latency - b.node.latency);

            let newOp;
            if (validNodes.length > 0) {
                const target = validNodes[0];
                newOp = { id: `op-${Date.now()}`, type: 'READ', objectId, node: target.node.id, status: 'SUCCESS', latency: target.node.latency + 2, timestamp: Date.now() };
            } else {
                newOp = { id: `op-${Date.now()}`, type: 'READ', objectId, node: 'NO REPLICA', status: 'FAILED', latency: 0, timestamp: Date.now() };
            }

            return { ...state, operations: [newOp, ...state.operations].slice(0, 50) };
        }

        case 'SIMULATE_WRITE': {
            const { objectId } = action.payload;
            const reps = state.replicas.filter(r => r.objectId === objectId);
            
            const onlineNodeCount = reps.filter(r => {
                const n = state.nodes.find(node => node.id === r.nodeId);
                return n && n.status === 'ONLINE';
            }).length;

            const rf = state.settings.rf;
            const quorumType = state.settings.writeQuorum;
            let success = false;

            if (quorumType === 'ONE' && onlineNodeCount >= 1) success = true;
            if (quorumType === 'MAJORITY' && onlineNodeCount >= Math.ceil(rf / 2)) success = true;
            if (quorumType === 'ALL' && onlineNodeCount >= rf) success = true;

            const newOp = {
                id: `op-${Date.now()}`,
                type: 'WRITE',
                objectId,
                node: success ? `QUORUM (${onlineNodeCount}/${rf})` : `FAILED (${onlineNodeCount}/${rf})`,
                status: success ? 'SUCCESS' : 'FAILED',
                latency: success ? Math.floor(Math.random() * 30) + 10 : 0,
                timestamp: Date.now()
            };

            let updatedObjects = [...state.objects];
            let updatedReplicas = [...state.replicas];

            if (success) {
                updatedObjects = updatedObjects.map(o => o.id === objectId ? { ...o, version: o.version + 1 } : o);
                updatedReplicas = updatedReplicas.map(r => r.objectId === objectId && state.nodes.find(n => n.id === r.nodeId)?.status === 'ONLINE' ? { ...r, version: r.version + 1 } : r);
            }

            return {
                ...state,
                objects: updatedObjects,
                replicas: updatedReplicas,
                operations: [newOp, ...state.operations].slice(0, 50)
            };
        }

        case 'UPLOAD_OBJECT': {
            const { file, checksum } = action.payload;
            const newObj = {
                id: `obj-${Date.now()}`,
                name: file.name,
                size: file.size,
                checksum: checksum,
                version: 1,
                status: 'HEALTHY',
                createdAt: Date.now(),
                lastVerified: Date.now()
            };

            const eligible = state.nodes.filter(n => n.status === 'ONLINE').sort(() => 0.5 - Math.random()).slice(0, state.settings.rf);
            const newReps = eligible.map(node => ({
                id: `rep-${newObj.id}-${node.id}`,
                objectId: newObj.id,
                nodeId: node.id,
                status: 'HEALTHY',
                checksum: newObj.checksum,
                version: 1,
                createdAt: Date.now(),
                lastVerified: Date.now()
            }));

            return {
                ...state,
                objects: [newObj, ...state.objects],
                replicas: [...state.replicas, ...newReps],
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'OBJECT_CREATED', message: `Uploaded ${file.name} with RF=${eligible.length}`, severity: 'info' }, ...state.events].slice(0, 150)
            };
        }

        case 'RESET': {
            return { ...initialState, events: [{ id: Date.now(), timestamp: Date.now(), type: 'SYSTEM_RESET', message: 'Simulation reset to initial state.', severity: 'info' }] };
        }

        case 'DEMO_START': {
            return { ...state, demoActive: true };
        }

        case 'DEMO_SETUP': {
            // Strict deterministic topology for demo
            const objId = state.objects[0].id;
            // Ensure NODE-01, 02, 03, 06 are fully clean and ONLINE
            let nextNodes = state.nodes.map(n => ({ ...n, status: 'ONLINE', latency: 10, cpu: 15 }));
            
            // Remove existing replicas of this object
            let nextReplicas = state.replicas.filter(r => r.objectId !== objId);
            
            // Assign explicitly to 01, 02, 03
            ['NODE-01', 'NODE-02', 'NODE-03'].forEach(nid => {
                nextReplicas.push({
                    id: `rep-${objId}-${nid}`,
                    objectId: objId,
                    nodeId: nid,
                    status: 'HEALTHY',
                    checksum: state.objects[0].checksum,
                    version: state.objects[0].version,
                    createdAt: Date.now(),
                    lastVerified: Date.now()
                });
            });

            // Clear jobs for this object
            let nextJobs = state.jobs.filter(j => j.objectId !== objId);

            return {
                ...state,
                nodes: nextNodes,
                replicas: nextReplicas,
                jobs: nextJobs,
                settings: { ...state.settings, autoRepair: false }, // Disable auto repair temporarily
                events: [{ id: Date.now(), timestamp: Date.now(), type: 'DEMO_START', message: 'Configured deterministic demo topology.', severity: 'info' }, ...state.events].slice(0, 150)
            };
        }

        case 'DEMO_START_REPAIR': {
            const { objectId, targetNode } = action.payload;
            const job = {
                id: `demo-repair-${Date.now()}`,
                type: 'REPAIR',
                objectId,
                failedNode: 'NODE-03',
                targetNode,
                progress: 0,
                status: 'QUEUED',
                startTime: Date.now()
            };
            return { ...state, jobs: [...state.jobs, job] };
        }

        case 'DEMO_END': {
            return { ...state, demoActive: false, settings: { ...state.settings, autoRepair: true } };
        }

        default:
            return state;
    }
}

const VaultContext = createContext();

// --- Components ---

const ToastContainer = ({ toasts }) => {
    const [visibleToasts, setVisibleToasts] = useState([]);
    const seenToasts = useRef(new Set());
    const timers = useRef(new Map());
    const initialized = useRef(false);
    const getToastKey = toast => `${toast.id}-${toast.type}-${toast.message}`;

    useEffect(() => {
        if (!initialized.current) {
            toasts.forEach(toast => seenToasts.current.add(getToastKey(toast)));
            initialized.current = true;
            return;
        }

        const newToasts = toasts.filter(toast => {
            const key = getToastKey(toast);
            if (seenToasts.current.has(key)) return false;
            seenToasts.current.add(key);
            return true;
        });

        if (newToasts.length === 0) return;

        setVisibleToasts(current => [...newToasts, ...current].slice(0, 3));
        newToasts.forEach(toast => {
            const key = getToastKey(toast);
            timers.current.set(key, window.setTimeout(() => {
                setVisibleToasts(current => current.filter(item => getToastKey(item) !== key));
                timers.current.delete(key);
            }, 5000));
        });
    }, [toasts]);

    useEffect(() => () => {
        timers.current.forEach(timer => window.clearTimeout(timer));
    }, []);

    return (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            {visibleToasts.map(t => (
                <div key={getToastKey(t)} className={`p-4 rounded shadow-lg border text-sm flex items-start gap-3 w-80 animate-in slide-in-from-right-8 bg-slate-900
                    ${t.severity === 'error' ? 'border-red-900/50 text-red-200' : t.severity === 'warning' ? 'border-amber-900/50 text-amber-200' : t.severity === 'success' ? 'border-emerald-900/50 text-emerald-200' : 'border-slate-700 text-slate-200'}`}>
                    {t.severity === 'error' && <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />}
                    {t.severity === 'warning' && <FileWarning className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />}
                    {t.severity === 'success' && <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />}
                    {t.severity === 'info' && <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />}
                    <div className="leading-tight">{t.message}</div>
                </div>
            ))}
        </div>
    );
};

const Card = ({ title, children, className = "", action }) => (
    <div className={`bg-slate-900/50 border border-slate-800 rounded-lg p-5 flex flex-col ${className}`}>
        <div className="flex justify-between items-center mb-4">
            <h3 className="text-slate-400 font-medium text-sm tracking-wide uppercase">{title}</h3>
            {action}
        </div>
        <div className="flex-1">{children}</div>
    </div>
);

const Metric = ({ label, value, subtext, status = "neutral" }) => (
    <div>
        <div className="text-slate-500 text-xs mb-1 uppercase">{label}</div>
        <div className={`text-2xl font-light mb-1 
            ${status === 'good' ? 'text-emerald-400' : status === 'warning' ? 'text-amber-400' : status === 'bad' ? 'text-red-400' : 'text-slate-100'}`}>
            {value}
        </div>
        {subtext && <div className="text-xs text-slate-500">{subtext}</div>}
    </div>
);

const Badge = ({ status }) => {
    const styles = {
        HEALTHY: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
        DEGRADED: "bg-amber-500/10 text-amber-400 border-amber-500/20",
        CRITICAL: "bg-red-500/10 text-red-400 border-red-500/20",
        UNAVAILABLE: "bg-slate-500/10 text-slate-400 border-slate-500/20",
        CORRUPTED: "bg-purple-500/10 text-purple-400 border-purple-500/20",
        SYNCING: "bg-blue-500/10 text-blue-400 border-blue-500/20",
        ONLINE: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
        OFFLINE: "bg-red-500/10 text-red-400 border-red-500/20",
        PARTITIONED: "bg-orange-500/10 text-orange-400 border-orange-500/20",
        STALE: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    };
    return (
        <span className={`px-2 py-0.5 rounded text-xs border font-medium whitespace-nowrap ${styles[status] || styles.UNAVAILABLE}`}>
            {status}
        </span>
    );
};

// --- Main Views ---

const Overview = () => {
    const { state } = useContext(VaultContext);
    
    const logicalStorage = state.objects.reduce((acc, o) => acc + o.size, 0);
    const physicalStorage = state.nodes.reduce((acc, n) => acc + n.used, 0);
    const baseStorage = state.nodes.length * 10 * 1024 * 1024 * 1024; // Exclude base OS storage from overhead calculation
    const pureReplicaStorage = physicalStorage - baseStorage;
    const overhead = logicalStorage > 0 ? (pureReplicaStorage / logicalStorage).toFixed(1) : 0;
    
    const activeNodes = state.nodes.filter(n => n.status === 'ONLINE').length;
    
    const objAvailability = state.objects.map(obj => {
        const reps = state.replicas.filter(r => r.objectId === obj.id && (r.status === 'HEALTHY' || r.status === 'SYNCING'));
        return reps.length >= state.settings.rf ? 1 : reps.length / state.settings.rf;
    });
    const avgAvailability = objAvailability.length > 0 ? (objAvailability.reduce((a,b) => a+b, 0) / objAvailability.length) * 100 : 100;
    
    const clusterStatus = activeNodes < 3 ? 'CRITICAL' : avgAvailability < 100 ? 'DEGRADED' : 'HEALTHY';

    const chartData = [
        { name: 'Used', value: physicalStorage, fill: '#3b82f6' },
        { name: 'Free', value: state.nodes.reduce((acc, n) => acc + n.capacity, 0) - physicalStorage, fill: '#1e293b' }
    ];

    return (
        <div className="space-y-6">
            <div className={`p-4 rounded-lg border flex items-center justify-between
                ${clusterStatus === 'HEALTHY' ? 'bg-emerald-900/20 border-emerald-900/50' : clusterStatus === 'DEGRADED' ? 'bg-amber-900/20 border-amber-900/50' : 'bg-red-900/20 border-red-900/50'}`}>
                <div className="flex items-center gap-4">
                    {clusterStatus === 'HEALTHY' ? <CheckCircle className="text-emerald-500 w-8 h-8" /> : 
                     clusterStatus === 'DEGRADED' ? <AlertTriangle className="text-amber-500 w-8 h-8" /> : 
                     <XCircle className="text-red-500 w-8 h-8" />}
                    <div>
                        <h2 className="text-lg font-medium text-slate-100">Cluster Status: {clusterStatus}</h2>
                        <p className="text-slate-400 text-sm">System availability based on simulated replica count.</p>
                    </div>
                </div>
                <div className="text-right">
                    <div className="text-2xl font-light text-slate-100">{avgAvailability.toFixed(1)}%</div>
                    <div className="text-sm text-slate-500 uppercase">Avg Availability</div>
                </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
                <Card title="Logical Storage">
                    <Metric label="Total Objects Size" value={formatBytes(logicalStorage)} subtext={`${state.objects.length} Objects`} />
                </Card>
                <Card title="Physical Storage">
                    <Metric label="Total Used Space" value={formatBytes(physicalStorage)} subtext={`${formatBytes(state.nodes.reduce((acc, n) => acc + n.capacity, 0))} Total`} />
                </Card>
                <Card title="Replication Overhead">
                    <Metric label="Multiplier" value={`${overhead}x`} subtext={`Target RF: ${state.settings.rf}`} />
                </Card>
                <Card title="Active Nodes">
                    <Metric label="Online" value={`${activeNodes} / ${state.nodes.length}`} status={activeNodes === state.nodes.length ? 'good' : 'warning'} />
                </Card>
            </div>

            <div className="grid grid-cols-3 gap-6">
                <Card title="Storage Utilization" className="col-span-1">
                    <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie data={chartData} dataKey="value" innerRadius={60} outerRadius={80} paddingAngle={2} stroke="none">
                                    {chartData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.fill} />
                                    ))}
                                </Pie>
                                <RechartsTooltip 
                                    formatter={(value) => formatBytes(value)} 
                                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f8fafc' }}
                                />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
                
                <Card title="Active Repair Jobs" className="col-span-2">
                    {state.jobs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-slate-500">
                            <CheckCircle className="w-8 h-8 mb-2 opacity-20" />
                            <p>No active repair jobs.</p>
                        </div>
                    ) : (
                        <div className="space-y-4 overflow-y-auto max-h-48 pr-2">
                            {state.jobs.map(job => (
                                <div key={job.id} className="bg-slate-800/50 p-3 rounded text-sm">
                                    <div className="flex justify-between items-center mb-2">
                                        <div className="font-medium text-slate-200">{job.type} • {state.objects.find(o => o.id === job.objectId)?.name || job.objectId}</div>
                                        <Badge status={job.status} />
                                    </div>
                                    <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                                        {job.failedNode && <span>{job.failedNode}</span>}
                                        {job.failedNode && <ArrowRight className="w-3 h-3" />}
                                        {job.targetNode && <span>{job.targetNode}</span>}
                                    </div>
                                    <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
                                        <div className="bg-blue-500 h-1.5 transition-all duration-300" style={{ width: `${job.progress}%` }}></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>
            
            <div className="flex justify-between text-sm text-slate-500">
                <div>Write Quorum: <span className="text-slate-300">{state.settings.writeQuorum}</span></div>
                {state.lastRecoveryTime && <div>Last Simulated Recovery: <span className="text-slate-300">{state.lastRecoveryTime.toFixed(1)}s</span></div>}
            </div>
        </div>
    );
};

const Objects = ({ onSelectObject }) => {
    const { state, dispatch } = useContext(VaultContext);
    
    const handleUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const checksum = await generateRealChecksum(file);
        dispatch({ type: 'UPLOAD_OBJECT', payload: { file, checksum } });
    };

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <h2 className="text-xl font-light text-slate-100">Stored Objects</h2>
                <label className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded text-sm cursor-pointer transition-colors flex items-center gap-2">
                    <UploadCloud className="w-4 h-4" />
                    Upload File
                    <input type="file" className="hidden" onChange={handleUpload} />
                </label>
            </div>
            
            <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase tracking-wide">
                        <tr>
                            <th className="p-4">Name</th>
                            <th className="p-4">Size</th>
                            <th className="p-4">Availability</th>
                            <th className="p-4">Status</th>
                            <th className="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                        {state.objects.map(obj => {
                            const reps = state.replicas.filter(r => r.objectId === obj.id);
                            const healthyCount = reps.filter(r => r.status === 'HEALTHY' || r.status === 'SYNCING').length;
                            const rf = state.settings.rf;
                            const pct = Math.round((healthyCount / rf) * 100);
                            
                            return (
                                <tr key={obj.id} className="hover:bg-slate-800/30 transition-colors">
                                    <td className="p-4">
                                        <div className="font-medium text-slate-200 cursor-pointer hover:text-blue-400 flex items-center gap-2" onClick={() => onSelectObject(obj)}>
                                            <FileText className="w-4 h-4 text-slate-500" />
                                            {obj.name}
                                        </div>
                                    </td>
                                    <td className="p-4 text-slate-400">{formatBytes(obj.size)}</td>
                                    <td className="p-4">
                                        <div className="flex items-center gap-2">
                                            <div className="w-16 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                                <div className={`h-1.5 ${pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(100, pct)}%` }}></div>
                                            </div>
                                            <span className="text-xs text-slate-500">{healthyCount}/{rf}</span>
                                        </div>
                                    </td>
                                    <td className="p-4"><Badge status={obj.status} /></td>
                                    <td className="p-4 text-right">
                                        <button className="text-slate-400 hover:text-white px-2 py-1 text-xs border border-slate-700 rounded transition-colors"
                                            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SIMULATE_READ', payload: { objectId: obj.id } }); }}>
                                            Read
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const Nodes = () => {
    const { state, dispatch } = useContext(VaultContext);

    return (
        <div className="space-y-4">
            <h2 className="text-xl font-light text-slate-100">Storage Nodes</h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                {state.nodes.map(node => (
                    <Card key={node.id} title={node.id} action={<Badge status={node.status} />} className={node.status !== 'ONLINE' ? 'opacity-70' : ''}>
                        <div className="space-y-4">
                            <div className="flex justify-between text-sm">
                                <span className="text-slate-500">Storage</span>
                                <span className="text-slate-300">{formatBytes(node.used)} / {formatBytes(node.capacity)}</span>
                            </div>
                            <div className="w-full bg-slate-800 rounded-full h-1.5 mb-2">
                                <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${(node.used / node.capacity) * 100}%` }}></div>
                            </div>
                            
                            <div className="grid grid-cols-3 gap-2 text-center text-xs border-y border-slate-800 py-3">
                                <div>
                                    <div className="text-slate-500 mb-1">CPU</div>
                                    <div className="text-slate-300">{node.cpu}%</div>
                                </div>
                                <div>
                                    <div className="text-slate-500 mb-1">Latency</div>
                                    <div className="text-slate-300">{node.latency}ms</div>
                                </div>
                                <div>
                                    <div className="text-slate-500 mb-1">Replicas</div>
                                    <div className="text-slate-300">{node.objectsStored}</div>
                                </div>
                            </div>
                            
                            <div className="flex gap-2">
                                {node.status === 'ONLINE' ? (
                                    <>
                                        <button className="flex-1 bg-slate-800 hover:bg-slate-700 text-xs py-2 rounded text-slate-300 transition-colors"
                                            onClick={() => dispatch({ type: 'FAIL_NODE', payload: node.id })}>Fail</button>
                                        <button className="flex-1 bg-slate-800 hover:bg-slate-700 text-xs py-2 rounded text-slate-300 transition-colors"
                                            onClick={() => dispatch({ type: 'PARTITION_NODE', payload: node.id })}>Partition</button>
                                    </>
                                ) : (
                                    <button className="flex-1 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-400 text-xs py-2 rounded transition-colors"
                                        onClick={() => dispatch({ type: 'RECOVER_NODE', payload: node.id })}>Recover Node</button>
                                )}
                            </div>
                        </div>
                    </Card>
                ))}
            </div>
        </div>
    );
};

const Integrity = () => {
    const { state, dispatch } = useContext(VaultContext);
    
    const corruptedReps = state.replicas.filter(r => r.status === 'CORRUPTED');
    const staleReps = state.replicas.filter(r => r.status === 'STALE');

    return (
        <div className="space-y-6">
            <h2 className="text-xl font-light text-slate-100">Integrity & Metadata</h2>
            
            <div className="grid grid-cols-3 gap-4">
                <Card title="Corrupted Replicas">
                    <Metric label="Mismatched Checksums" value={corruptedReps.length} status={corruptedReps.length > 0 ? 'bad' : 'good'} />
                </Card>
                <Card title="Stale Metadata">
                    <Metric label="Version Mismatches" value={staleReps.length} status={staleReps.length > 0 ? 'warning' : 'good'} />
                </Card>
                <Card title="Verification">
                    <Metric label="Auto-Verify" value="Enabled" status="good" subtext="Background hashing active" />
                </Card>
            </div>

            <Card title="Metadata Consistency Reconciliation">
                {staleReps.length === 0 ? (
                    <div className="text-slate-500 text-sm py-4">No version mismatches detected. All replicas are synchronized.</div>
                ) : (
                    <div className="space-y-3">
                        {staleReps.map(rep => {
                            const obj = state.objects.find(o => o.id === rep.objectId);
                            return (
                                <div key={rep.id} className="flex items-center justify-between bg-slate-800/50 p-3 rounded">
                                    <div>
                                        <div className="text-sm text-slate-200">{obj?.name} on {rep.nodeId}</div>
                                        <div className="text-xs text-amber-500">Replica Version: {rep.version} | Object Version: {obj?.version}</div>
                                    </div>
                                    <button className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded transition-colors"
                                        onClick={() => dispatch({ type: 'RECONCILE_METADATA', payload: { replicaId: rep.id } })}>
                                        Reconcile
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </Card>
            
            <Card title="Simulate Corruption">
                <div className="text-sm text-slate-400 mb-4">Introduce bit-rot to a random healthy replica to test detection and automatic repair mechanisms.</div>
                <div className="flex flex-wrap gap-2">
                    {state.objects.map(obj => (
                        <button key={obj.id} className="bg-slate-800 hover:bg-purple-900/50 text-slate-300 text-xs px-3 py-2 rounded transition-colors"
                            onClick={() => dispatch({ type: 'CORRUPT_REPLICA', payload: { objectId: obj.id } })}>
                            Corrupt {obj.name}
                        </button>
                    ))}
                </div>
            </Card>
        </div>
    );
};

const OperationsMonitor = () => {
    const { state, dispatch } = useContext(VaultContext);
    
    const simulateLoad = async () => {
        const actions = ['SIMULATE_READ', 'SIMULATE_WRITE', 'VERIFY_OBJECT', 'SIMULATE_READ'];
        for (let action of actions) {
            const obj = state.objects[Math.floor(Math.random() * state.objects.length)];
            dispatch({ type: action, payload: { objectId: obj.id } });
            await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
        }
    };

    return (
        <Card title="Operations Monitor" action={
            <button className="text-xs bg-blue-900/50 hover:bg-blue-800 text-blue-300 px-3 py-1 rounded transition-colors" onClick={simulateLoad}>
                Simulate Load
            </button>
        }>
            <div className="space-y-2 max-h-64 overflow-y-auto font-mono text-xs pr-2">
                {state.operations.length === 0 ? <div className="text-slate-600 italic">No operations recorded...</div> : null}
                {state.operations.map(op => {
                    const obj = state.objects.find(o => o.id === op.objectId);
                    return (
                        <div key={op.id} className="flex items-center justify-between py-1 border-b border-slate-800/50 last:border-0">
                            <div className="flex items-center gap-3 w-1/2">
                                <span className={`w-12 font-bold ${op.type === 'WRITE' ? 'text-amber-400' : op.type === 'READ' ? 'text-blue-400' : 'text-purple-400'}`}>{op.type}</span>
                                <span className="text-slate-400 truncate">{obj?.name || op.objectId}</span>
                            </div>
                            <div className="text-slate-500 w-1/4 truncate">{op.node}</div>
                            <div className="w-1/4 flex justify-between items-center text-right">
                                <span className={op.status === 'SUCCESS' ? 'text-emerald-500' : op.status === 'WARNING' ? 'text-amber-500' : 'text-red-500'}>{op.status}</span>
                                {op.latency > 0 && <span className="text-slate-600">{op.latency}ms</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
};

const ObjectModal = ({ object, onClose }) => {
    const { state, dispatch } = useContext(VaultContext);
    if (!object) return null;

    const replicas = state.replicas.filter(r => r.objectId === object.id);
    const rf = state.settings.rf;
    const healthy = replicas.filter(r => r.status === 'HEALTHY' || r.status === 'SYNCING').length;

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-in fade-in">
            <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-3xl flex flex-col max-h-[90vh]">
                <div className="p-5 border-b border-slate-800 flex justify-between items-center">
                    <div>
                        <h2 className="text-xl font-light text-slate-100 flex items-center gap-2">
                            <FileText className="text-blue-500 w-5 h-5" /> {object.name}
                        </h2>
                        <div className="text-xs font-mono text-slate-500 mt-1">ID: {object.id}</div>
                    </div>
                    <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors"><XCircle className="w-6 h-6" /></button>
                </div>
                
                <div className="p-5 overflow-y-auto space-y-6">
                    <div className="grid grid-cols-4 gap-4">
                        <Metric label="Status" value={<Badge status={object.status} />} />
                        <Metric label="Size" value={formatBytes(object.size)} />
                        <Metric label="Version" value={`v${object.version}`} />
                        <Metric label="Availability" value={`${healthy}/${rf}`} status={healthy >= rf ? 'good' : healthy > 0 ? 'warning' : 'bad'} />
                    </div>
                    
                    <div>
                        <div className="text-slate-500 text-xs uppercase mb-1">
                            {object.id.startsWith('obj-00') ? 'Sample Checksum' : 'SHA-256 Checksum'}
                        </div>
                        <div className="bg-slate-950 p-2 rounded text-xs font-mono text-slate-400 break-all border border-slate-800">
                            {object.checksum}
                        </div>
                    </div>

                    <div>
                        <div className="flex justify-between items-center mb-3">
                            <h3 className="text-sm uppercase tracking-wide text-slate-400">Replica Locations</h3>
                            <div className="flex gap-2">
                                <button className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded text-xs transition-colors"
                                    onClick={() => dispatch({ type: 'VERIFY_OBJECT', payload: { objectId: object.id } })}>Verify Integrity</button>
                                <button className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded text-xs transition-colors"
                                    onClick={() => dispatch({ type: 'CORRUPT_REPLICA', payload: { objectId: object.id } })}>Corrupt Random</button>
                            </div>
                        </div>
                        <div className="border border-slate-800 rounded overflow-hidden">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-slate-800/50 text-slate-400 text-xs">
                                    <tr>
                                        <th className="p-3">Node</th>
                                        <th className="p-3">Status</th>
                                        <th className="p-3">Version</th>
                                        <th className="p-3">
                                            {object.id.startsWith('obj-00') ? 'Sample Checksum' : 'Checksum'}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800 text-slate-300">
                                    {replicas.map(rep => (
                                        <tr key={rep.id}>
                                            <td className="p-3">{rep.nodeId}</td>
                                            <td className="p-3"><Badge status={rep.status} /></td>
                                            <td className={`p-3 ${rep.version !== object.version ? 'text-amber-500 font-bold' : ''}`}>v{rep.version}</td>
                                            <td className="p-3 font-mono text-xs max-w-[200px] truncate" title={rep.checksum}>
                                                <span className={rep.checksum !== object.checksum ? 'text-red-400 font-bold' : ''}>{rep.checksum.substring(0, 16)}...</span>
                                            </td>
                                        </tr>
                                    ))}
                                    {replicas.length === 0 && <tr><td colSpan="4" className="p-3 text-center text-slate-500">No replicas found.</td></tr>}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const DemoOverlay = ({ active }) => {
    const { state, dispatch } = useContext(VaultContext);
    const [stepTitle, setStepTitle] = useState('Initializing Deterministic Demo...');
    const [progress, setProgress] = useState(0);

    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => {
        if (!active) return;
        
        let isCancelled = false;

        const runSequence = async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            await sleep(500); // Allow overlay to mount
            
            // 1. Setup
            if(isCancelled) return;
            dispatch({ type: 'DEMO_SETUP' });
            setProgress(10);
            await sleep(1500);
            if(isCancelled) return;
            
            // 2. Validate
            setStepTitle('Object replicated. 3/3 Replicas Healthy on NODE-01, 02, 03.');
            setProgress(25);
            await sleep(2500);
            if(isCancelled) return;
            
            // 3. Fail
            setStepTitle('Simulating unexpected hardware failure on NODE-03...');
            setProgress(40);
            dispatch({ type: 'FAIL_NODE', payload: 'NODE-03' });
            await sleep(2500);
            if(isCancelled) return;
            
            // 4. Detect & Repair
            setStepTitle('Failure detected. Object DEGRADED. Starting targeted repair to NODE-06...');
            setProgress(50);
            const objId = stateRef.current.objects[0].id;
            dispatch({ type: 'DEMO_START_REPAIR', payload: { objectId: objId, targetNode: 'NODE-06' } });
            
            // 5. Poll for repair completion (Wait for real reducer logic)
            let jobDone = false;
            let checks = 0;
            while (!jobDone && checks < 30) {
                if(isCancelled) return;
                await sleep(500);
                const s = stateRef.current;
                const job = s.jobs.find(j => j.type === 'REPAIR' && j.objectId === objId && j.targetNode === 'NODE-06');
                if (job) {
                    setProgress(50 + (job.progress / 2));
                    if (job.status === 'COMPLETED') jobDone = true;
                }
                checks++;
            }
            if(isCancelled) return;

            // 6. Verify
            setStepTitle('Repair complete. Verifying checksums & metadata...');
            dispatch({ type: 'VERIFY_OBJECT', payload: { objectId: objId } });
            await sleep(1500);
            if(isCancelled) return;

            // 7. Finish
            setStepTitle(`Checksum Match. System HEALTHY. Recovery Time: ${stateRef.current.lastRecoveryTime?.toFixed(1) || 'X'}s`);
            setProgress(100);
            await sleep(4000);
            if(!isCancelled) dispatch({ type: 'DEMO_END' });
        };

        runSequence();
        return () => { isCancelled = true; };
    }, [active, dispatch]);

    if (!active) return null;

    return (
        <div className="fixed inset-0 bg-slate-950/90 flex flex-col items-center justify-center z-[100] p-8 animate-in fade-in duration-500 backdrop-blur-sm">
            <div className="max-w-2xl w-full text-center space-y-8">
                <ShieldCheck className="w-20 h-20 text-blue-500 mx-auto animate-pulse" />
                <h1 className="text-3xl font-light text-white tracking-wide">Automated Fault Tolerance Demo</h1>
                
                <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg text-left shadow-2xl">
                    <div className="text-xl text-slate-200 mb-6 font-medium h-12 flex items-center">{stepTitle}</div>
                    
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden mb-6">
                        <div className="bg-blue-500 h-2 transition-all duration-300" style={{ width: `${progress}%` }}></div>
                    </div>
                    
                    <div className="grid grid-cols-4 gap-2 text-center text-xs text-slate-500">
                        <div className={progress >= 25 ? "text-emerald-500" : ""}>1. REPLICATE</div>
                        <div className={progress >= 40 ? "text-amber-500" : ""}>2. FAIL NODE</div>
                        <div className={progress >= 50 ? "text-blue-500" : ""}>3. REBUILD</div>
                        <div className={progress >= 100 ? "text-emerald-500" : ""}>4. VERIFY</div>
                    </div>
                </div>
                
                <p className="text-slate-500 text-sm">Please wait while the simulation controls the cluster...</p>
                <button className="text-slate-500 hover:text-white underline text-xs mt-4" onClick={() => dispatch({ type: 'DEMO_END' })}>Abort Demo</button>
            </div>
        </div>
    );
};


// --- App Container ---

export default function App() {
    const [state, dispatch] = useReducer(vaultReducer, initialState);
    const [activeTab, setActiveTab] = useState('Overview');
    const [selectedObject, setSelectedObject] = useState(null);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // Global simulation tick
    useEffect(() => {
        const interval = setInterval(() => {
            dispatch({ type: 'TICK', payload: { allowTick: true } });
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    const navItems = ['Overview', 'Objects', 'Storage Nodes', 'Replication', 'Integrity', 'Activity', 'Settings'];

    return (
        <VaultContext.Provider value={{ state, dispatch }}>
            <div className="min-h-screen bg-[#0b1121] text-slate-300 font-sans selection:bg-blue-900 flex overflow-hidden">
                {/* Sidebar */}
                <div className="w-64 bg-slate-950/50 border-r border-slate-800 flex flex-col shrink-0">
                    <div className="p-6 flex items-center gap-3 border-b border-slate-800/50">
                        <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center shadow-[0_0_15px_rgba(37,99,235,0.4)]">
                            <Database className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-slate-100 tracking-wider">VAULT</h1>
                            <div className="text-[10px] text-blue-400 uppercase tracking-widest">Distributed Storage</div>
                        </div>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto py-4">
                        <nav className="space-y-1 px-3">
                            {navItems.map(item => (
                                <button key={item} 
                                    onClick={() => setActiveTab(item)}
                                    className={`w-full text-left px-4 py-2.5 rounded text-sm transition-colors flex items-center gap-3
                                    ${activeTab === item ? 'bg-blue-900/30 text-blue-400 font-medium' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                                    {item === 'Overview' && <BarChart3 className="w-4 h-4" />}
                                    {item === 'Objects' && <FileText className="w-4 h-4" />}
                                    {item === 'Storage Nodes' && <Server className="w-4 h-4" />}
                                    {item === 'Replication' && <Network className="w-4 h-4" />}
                                    {item === 'Integrity' && <ShieldCheck className="w-4 h-4" />}
                                    {item === 'Activity' && <ActivitySquare className="w-4 h-4" />}
                                    {item === 'Settings' && <Settings className="w-4 h-4" />}
                                    {item}
                                </button>
                            ))}
                        </nav>
                    </div>

                    <div className="p-4 border-t border-slate-800/50 space-y-3">
                        <button className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2.5 rounded transition-all shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2"
                            onClick={() => {
                                if (state.demoActive) return;
                                setActiveTab('Overview');
                                dispatch({ type: 'DEMO_START' });
                            }}>
                            <PlayCircle className="w-4 h-4" />
                            Run Failure Demo
                        </button>
                        <button className="w-full bg-slate-900 hover:bg-slate-800 text-slate-400 text-xs py-2 rounded transition-colors"
                            onClick={() => setShowResetConfirm(true)}>
                            Reset Simulation
                        </button>
                    </div>
                </div>

                {/* Main Content */}
                <div className="flex-1 flex flex-col h-screen overflow-hidden relative">
                    <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-900/20 shrink-0">
                        <h2 className="text-xl font-light text-slate-200">{activeTab}</h2>
                        <div className="flex items-center gap-6 text-sm">
                            <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${state.settings.autoRepair ? 'bg-emerald-500' : 'bg-slate-600'}`}></div>
                                <span className="text-slate-500 uppercase text-xs">Auto-Repair</span>
                            </div>
                            <div className="flex items-center gap-2 text-slate-400">
                                <Clock className="w-4 h-4" />
                                <span className="font-mono text-xs">TICK ACTIVE</span>
                            </div>
                        </div>
                    </header>

                    <main className="flex-1 overflow-y-auto p-8 bg-gradient-to-b from-transparent to-slate-950/50">
                        <div className="max-w-6xl mx-auto">
                            {activeTab === 'Overview' && <Overview />}
                            {activeTab === 'Objects' && <Objects onSelectObject={setSelectedObject} />}
                            {activeTab === 'Storage Nodes' && <Nodes />}
                            {activeTab === 'Integrity' && <Integrity />}
                            
                            {activeTab === 'Replication' && (
                                <div className="space-y-6">
                                    <h2 className="text-xl font-light text-slate-100">Replication & Durability Policy</h2>
                                    <div className="grid grid-cols-2 gap-6">
                                        <Card title="Global Configuration">
                                            <div className="space-y-6">
                                                <div>
                                                    <label className="block text-sm text-slate-400 mb-2">Replication Factor (RF)</label>
                                                    <div className="flex gap-2">
                                                        {[1,2,3,4,5].map(rf => (
                                                            <button key={rf} 
                                                                className={`flex-1 py-2 rounded text-sm transition-colors ${state.settings.rf === rf ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                                                                onClick={() => dispatch({ type: 'UPDATE_SETTINGS', payload: { rf } })}>
                                                                {rf}x
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <p className="text-xs text-slate-500 mt-2">Changing RF triggers automatic cluster rebalancing jobs.</p>
                                                </div>
                                                <div>
                                                    <label className="block text-sm text-slate-400 mb-2">Write Quorum Requirement</label>
                                                    <div className="flex gap-2">
                                                        {['ONE', 'MAJORITY', 'ALL'].map(q => (
                                                            <button key={q} 
                                                                className={`flex-1 py-2 rounded text-sm transition-colors ${state.settings.writeQuorum === q ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                                                                onClick={() => dispatch({ type: 'UPDATE_SETTINGS', payload: { writeQuorum: q } })}>
                                                                {q}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        </Card>
                                        <OperationsMonitor />
                                    </div>
                                </div>
                            )}

                            {activeTab === 'Activity' && (
                                <Card title="System Event Log" className="h-full min-h-[600px]">
                                    <div className="space-y-1 font-mono text-xs">
                                        {state.events.map((ev, i) => (
                                            <div key={`${ev.id}-${i}`} className={`flex gap-4 py-1.5 border-b border-slate-800/30 last:border-0
                                                ${ev.severity === 'error' ? 'text-red-400' : ev.severity === 'warning' ? 'text-amber-400' : ev.severity === 'success' ? 'text-emerald-400' : 'text-slate-400'}`}>
                                                <div className="text-slate-600 w-24 shrink-0">{new Date(ev.timestamp).toLocaleTimeString()}</div>
                                                <div className="w-40 font-bold shrink-0">{ev.type}</div>
                                                <div className="truncate">{ev.message}</div>
                                            </div>
                                        ))}
                                    </div>
                                </Card>
                            )}

                            {activeTab === 'Settings' && (
                                <div className="max-w-2xl space-y-6">
                                    <Card title="Simulation Controls">
                                        <div className="space-y-4">
                                            <label className="flex items-center justify-between p-4 bg-slate-900/50 rounded border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                                                <div>
                                                    <div className="font-medium text-slate-200">Automatic Repair</div>
                                                    <div className="text-sm text-slate-500">Detect unavailable replicas and rebuild automatically</div>
                                                </div>
                                                <div className={`w-12 h-6 rounded-full transition-colors relative ${state.settings.autoRepair ? 'bg-blue-600' : 'bg-slate-700'}`}
                                                     onClick={() => dispatch({ type: 'UPDATE_SETTINGS', payload: { autoRepair: !state.settings.autoRepair } })}>
                                                    <div className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${state.settings.autoRepair ? 'translate-x-6' : ''}`}></div>
                                                </div>
                                            </label>
                                            <label className="flex items-center justify-between p-4 bg-slate-900/50 rounded border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                                                <div>
                                                    <div className="font-medium text-slate-200">Automatic Rebalancing</div>
                                                    <div className="text-sm text-slate-500">Redistribute objects when nodes return or RF changes</div>
                                                </div>
                                                <div className={`w-12 h-6 rounded-full transition-colors relative ${state.settings.autoRebalance ? 'bg-blue-600' : 'bg-slate-700'}`}
                                                     onClick={() => dispatch({ type: 'UPDATE_SETTINGS', payload: { autoRebalance: !state.settings.autoRebalance } })}>
                                                    <div className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${state.settings.autoRebalance ? 'translate-x-6' : ''}`}></div>
                                                </div>
                                            </label>
                                        </div>
                                    </Card>
                                </div>
                            )}
                        </div>
                    </main>
                </div>
            </div>

            <ObjectModal object={selectedObject} onClose={() => setSelectedObject(null)} />
            <DemoOverlay active={state.demoActive} />
            <ToastContainer toasts={state.events.slice(0, 3)} />

            {/* Reset Confirmation Modal */}
            {showResetConfirm && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] p-4">
                    <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg max-w-md w-full">
                        <h3 className="text-lg font-medium text-white mb-2">Reset Simulation?</h3>
                        <p className="text-slate-400 text-sm mb-6">This will destroy all simulated objects, clear the event log, and return the cluster to its initial healthy state.</p>
                        <div className="flex justify-end gap-3">
                            <button className="px-4 py-2 text-sm text-slate-300 hover:text-white" onClick={() => setShowResetConfirm(false)}>Cancel</button>
                            <button className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded" onClick={() => { dispatch({ type: 'RESET' }); setShowResetConfirm(false); }}>Reset Everything</button>
                        </div>
                    </div>
                </div>
            )}
        </VaultContext.Provider>
    );
}