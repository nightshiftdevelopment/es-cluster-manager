#!/bin/bash -ex
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

#update instance
yum update -y

#set aws region information
aws configure set region us-east-1

#['http://10.0.0.42:9200', 'http://10.0.0.49:9200', 'http://10.0.0.37:9200', 'http://10.0,0.47:9200', 'http://10.0.0.57:9200']
#get instance id from the aws metadata service
instance_id=`curl -s http://169.254.169.254/latest/meta-data/instance-id`

#get some params that we'll use to bootstrap kibana
kibana_instance_name=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 KIBANA_INSTANCE_NAME | grep Value | cut -f2 -d: | tr -d ',' | tr -d '"'`

elasticsearch_hosts=`aws ec2 describe-tags --filters "Name=resource-id,Values=${instance_id}" | grep -2 ES_HOSTS | grep Value | cut -d ':' -f 2- | tr -d '"' | tr -d ',' | tr -d ' '`

#grab the rpm for kibana
wget https://artifacts.elastic.co/downloads/kibana/kibana-6.6.0-x86_64.rpm

#install kibana
rpm --install kibana-6.6.0-x86_64.rpm

#update ec2-user with kibana group
usermod -a -G kibana ec2-user

chkconfig --add kibana

#change permissions so group can do what it needs to do
chown -R kibana:kibana /etc/kibana
chmod -R g+w /etc/kibana


#update yml -  some things just because we want them explicit
sed -i -e 's|#server.port: 5601|server.port: 5601|g' /etc/kibana/kibana.yml
sed -i -e 's|#server.host: "localhost"|server.host: "0.0.0.0"|g' /etc/kibana/kibana.yml
sed -i -e 's|#server.name: "your-hostname"|server.name: '"$kibana_instance_name"'|g' /etc/kibana/kibana.yml
sed -i -e 's|#elasticsearch.hosts: \["http://localhost:9200"\]|elasticsearch.hosts: \["'"$elasticsearch_hosts"'"\]|g' /etc/kibana/kibana.yml



service kibana start

chown -R kibana:kibana /var/log/kibana
chmod g+r /var/log/kibana/
