# ZTP Kubernetes Deployment

## Prerequisites
- Kubernetes cluster (1.28+)
- kubectl configured
- Container images built and pushed to a registry
- A LoadBalancer controller (MetalLB for bare-metal, cloud LB for cloud)

## Deploy Order

```bash
# 1. Create namespace
kubectl apply -f namespace.yaml

# 2. Storage
kubectl apply -f storage/pvcs.yaml

# 3. Config & Secrets (edit secrets.yaml with real values first!)
kubectl apply -f configmaps/
kubectl apply -f secrets/

# 4. Database
kubectl apply -f deployments/postgres.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n ztp --timeout=60s

# 5. All other services
kubectl apply -f deployments/
kubectl apply -f services/
```

## Notes
- **Kea DHCP**: Uses `hostNetwork: true` as a DaemonSet. DHCP broadcasts require direct host network access.
- **Secrets**: The `secrets.yaml` file contains placeholder base64 values. Replace before deploying. Consider using Sealed Secrets or a vault integration.
- **DHCP in k8s**: For multi-node clusters, ensure only one node runs the Kea DaemonSet pod in each broadcast domain using `nodeSelector` or taints.
- **LoadBalancer IPs**: Set `spec.loadBalancerIP` on the TFTP, Syslog, and DNS services to pin them to stable IPs.
