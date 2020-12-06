#!/bin/bash -ex
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

#update instance
yum update -y

#set aws region information
aws configure set region us-east-1

#get instance id from the aws metadata service
instance_id=`curl -s http://169.254.169.254/latest/meta-data/instance-id`
launch_index=`curl -s http://169.254.169.254/latest/meta-data/ami-launch-index`

instance_family=`aws ec2 describe-instance-attribute --instance-id ${instance_id} --attribute instanceType | grep Value | tr -d ' ' | cut -f2 -d: | tr -d '"' | cut -f1 -d.`

#get cluster details
cluster_name=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_CLUSTER_NAME | grep Value | cut -f2 -d: | cut -f2 -d\"`
es_version=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_VERSION | grep Value | cut -f2 -d: |  cut -f2 -d\"`
node_name=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_NODE_NAME_PREFIX | grep Value | cut -f2 -d: | cut -f2 -d\"`
node_roles=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_NODE_ROLES | grep Value | cut -f2 -d: | cut -f2 -d\"`


xpack_enabled=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_XPACK_ENABLED | grep Value | cut -f2 -d: | cut -f2 -d\"`
remote_monitoring=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_REMOTE_MONITORING | grep Value | cut -f2 -d: | cut -f2 -d\"`
monitoring_cluster=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_MONITORING_CLUSTER | grep Value | cut -f2 -d: | cut -f2 -d\"`

initial_master_nodes=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_INITIAL_MASTER_NODES | grep Value | cut -f2 -d: | cut -f2 -d\"`


if [ "$xpack_enabled" == "true" ]; then discovery_protocol="https"; else discovery_protocol="http"; fi

#get the last octect of the private ipaddress so we can ensure unique names
last_octet=`curl --silent http://169.254.169.254/latest/meta-data/local-ipv4 | cut -d . -f 4`

if [ -z "$initial_master_nodes" ]; then
  instance_name="$node_name-$last_octet"
else
  instance_name="$node_name-seed-$launch_index"
fi

#update the instance with a name tag
aws ec2 create-tags --resources $instance_id --tags Key=Name,Value=$instance_name

#delete the cluster initial master nodes after we've used it the first time.
aws ec2 delete-tags --resources $instance_id --tags Key=ES_INITIAL_MASTER_NODES

#update java
#yum install -y java-1.8.0-openjdk
yum remove -y java-1.7.0-openjdk

#system settings
swapoff -a
sysctl -w vm.max_map_count=262144
sysctl -w vm.swappiness=1

echo "* soft  nofile  65536" | tee -a /etc/security/limits.conf > /dev/null
echo "* hard  nofile  65536" | tee -a /etc/security/limits.conf > /dev/null
echo "* hard  memlock unlimited" | tee -a /etc/security/limits.conf > /dev/null
echo "* hard  nproc 4096" | tee -a /etc/security/limits.conf > /dev/null
echo "elasticsearch soft memlock unlimited" | tee -a /etc/security/limits.conf > /dev/null
echo "elasticsearch hard memlock unlimited" | tee -a /etc/security/limits.conf > /dev/null

#download and install elasticsearch
wget https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-$es_version-x86_64.rpm
rpm -i  elasticsearch-$es_version-x86_64.rpm


#add ec2-user to es group
usermod -a -G elasticsearch ec2-user

#setup the service
chkconfig --add elasticsearch
chkconfig elasticsearch on

if [ "$instance_family" == "i3" ]; then
  #set partitions, create filesystem and mount the SSD
  echo -e "o\nn\np\n1\n\n\nw" | fdisk /dev/nvme0n1
  partprobe /dev/nvme0n1
  mkfs.ext4 /dev/nvme0n1p1
  mkdir /data
  mount -t ext4 /dev/nvme0n1p1 /data

  #store in fstab
  echo "/dev/nvme0n1p1  /data ext4  defaults  0 1" >> /etc/fstab
fi


#create data and log directories
mkdir -p /data/elasticsearch
mkdir -p /data/elasticsearch/logs
mkdir -p /data/elasticsearch/data
chown -R elasticsearch:elasticsearch /data/elasticsearch

#update the jvm configuration for elasticsearch
totalMem=`free -m | grep "Mem:" | awk '{print $2}'`
halfMem=`expr $totalMem / 2`

#set JVM to half of available machine memory
sed -i -e 's/-Xms1g/-Xms'$halfMem'm/g' /etc/elasticsearch/jvm.options
sed -i -e 's/-Xmx1g/-Xmx'$halfMem'm/g' /etc/elasticsearch/jvm.options
sed -i -e 's/\/var\/log\/elasticsearch/\/data\/elasticsearch\/logs/g' /etc/elasticsearch/jvm.options
sed -i -e 's/\/var\/lib\/elasticsearch/\/data\/elasticsearch\/heapdump/g' /etc/elasticsearch/jvm.options

echo "-Dio.netty.recycler.maxCapacityPerThread=0" | tee -a /etc/elasticsearch/jvm.options > /dev/null
echo "-Dio.netty.allocator.type=unpooled" | tee -a /etc/elasticsearch/jvm.options > /dev/null
echo "-XX:+UnlockDiagnosticVMOptions" | tee -a /etc/elasticsearch/jvm.options > /dev/null
#echo "-XX:+PrintCompressedOopsMode" | tee -a /etc/elasticsearch/jvm.options > /dev/null


#update the elasticsearch configuration
sed -i -e 's|#cluster.name: my-application|cluster.name: '$cluster_name'|g' /etc/elasticsearch/elasticsearch.yml
sed -i -e 's|#node.name: node-1|node.name: '$instance_name'|g' /etc/elasticsearch/elasticsearch.yml
sed -i -e 's|path.data: /var/lib/elasticsearch|path.data: /data/elasticsearch/data|g' /etc/elasticsearch/elasticsearch.yml
sed -i -e 's|path.logs: /var/log/elasticsearch|path.logs: /data/elasticsearch/logs|g' /etc/elasticsearch/elasticsearch.yml
sed -i -e 's|#network.host: 192.168.0.1|network.host: [_eth0_,_local_]|g' /etc/elasticsearch/elasticsearch.yml
echo "discovery.seed_providers: ec2" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
echo "discovery.ec2.protocol: $discovery_protocol" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
echo "node.roles: [$node_roles]" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
echo "bootstrap.memory_lock: true" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null

#echo "reindex.remote.whitelist: 172.31.*.*:9200" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null #reindex from anyone within the vpc is allowed
echo "" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null

if [ "$xpack_enabled" == "true" ]; then
  #add the expack settings to the configuration for ssl between nodes
  echo "#X-Pack Settings" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "xpack.security.enabled: true" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "xpack.security.audit.enabled: true" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "xpack.security.transport.ssl.enabled: true" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "xpack.security.transport.ssl.verification_mode: certificate" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "xpack.security.transport.ssl.keystore.path: certs/elastic-certificates.p12" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "xpack.security.transport.ssl.truststore.path: certs/elastic-certificates.p12" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
  echo "action.auto_create_index: .security,.monitoring*,.watches,.triggered_watches,.watcher-history*,.ml*" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null

  #get certificates from s3
  mkdir /etc/elasticsearch/certs
  aws s3 cp s3://elasticsearch-management/certificates/elastic-certificates.p12 /etc/elasticsearch/certs/


  #give elasticsearch permissions to the certs folder
  chown -R elasticsearch:elasticsearch /etc/elasticsearch/certs
fi

echo "xpack.watcher.enabled: false" >> /etc/elasticsearch/elasticsearch.yml
echo "xpack.monitoring.collection.enabled: true" >> /etc/elasticsearch/elasticsearch.yml

#add the monitoring cluster
if [ "$remote_monitoring" == "true" ]; then
  echo "xpack.monitoring.exporters.esmonitor:" >> /etc/elasticsearch/elasticsearch.yml
  echo "  type: http" >> /etc/elasticsearch/elasticsearch.yml
  echo "  host: [\"$monitoring_cluster:9200\""] >> /etc/elasticsearch/elasticsearch.yml
fi

#install the discovery plugin so ndoes can find each other.
/usr/share/elasticsearch/bin/elasticsearch-plugin install discovery-ec2 --batch
/usr/share/elasticsearch/bin/elasticsearch-plugin install repository-s3 --batch

#aws keys
#echo "" /usr/share/elasticsearch/bin/elasticsearch-keystore add --stdin s3.client.default.access_key
#echo "" /usr/share/elasticsearch/bin/elasticsearch-keystore add --stdin s3.client.default.secret_key


#set the default bootstrap password for the elasticuser
#echo "" | /usr/share/elasticsearch/bin/elasticsearch-keystore add "bootstrap.password"


if [ -z "$initial_master_nodes" ]; then
  #start es service
  service elasticsearch start
else
  sudo -u elasticsearch /usr/share/elasticsearch/bin/elasticsearch -Ecluster.initial_master_nodes=$initial_master_nodes
  echo "bootstrap.memory_lock: true" | tee -a /etc/elasticsearch/elasticsearch.yml > /dev/null
fi
