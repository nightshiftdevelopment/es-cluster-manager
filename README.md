![Logo](./logo.png)
# ESCM - The Elasticsearch Cluster Manager
----

ESCM is a nodejs project designed to help you rapidly deploy and destroy new Elasticsearch clusters within an AWS environment. You can additionally add and remove new nodes to your clusters.

Think of this as the poor-man's ECE.

## Installation

Clone this repository and run the following.

```bash
cd es-cluster-manager && npm install && npm run build
```

After running these commands a new directory `bin` should appear in the es-cluster-manager with three binary files. One for each platform, linux, macos, and windows. You should run the respective binary for your platform.

Alternatively you can just download the latest binaries for the specified platform:
* [Linux](https://github.com/nightshiftdevelopment/es-cluster-manager/releases/download/v.1.1.0/escm-linux)
* [MacOs](https://github.com/nightshiftdevelopment/es-cluster-manager/releases/download/v.1.1.0/escm-macos)
* [Windows](https://github.com/nightshiftdevelopment/es-cluster-manager/releases/download/v.1.1.0/escm-win.exe)


## Usage

Running `./escm-<platform> --help` should display the following help output. For the remainder of the documentation we will assume the platform is linux.

The program can also be run by using `node escm.js`



```
$ ./bin/escm-macos --help

Usage: escm [options] [command]

Elasticsearch Cluster Manager

Options:
  -V, --version                       output the version number
  --esHostname <esHostname>           specify an elasticsearch host name for the management tracker
  --esPort <esPort>                   specify an elasticsearch port for the management tracker
  --esUsername <esUsername>           specify a user name for elasticsearch authentication
  --esPassword <esPassword>           specify a password for elasticsearch authentication
  --esProtocol <esProtocol>           specify a protocol for connecting to elasticsearch
  -h, --help                          output usage information

Commands:
  create-cluster|c [options]          Create a new Elasticsearch Cluster
  list-cluster-params [options]       List a specific parameter for all of the instances in an existing cluster
  list-cluster-instances|l [options]  List the instance ids of an existing cluster
  destroy-cluster|d [options]         Destroys an existing cluster with the name specified
  add-nodes|a [options]               Add a new nodes to an existing cluster.
  remove-nodes|r [options]            Remove a list of nodes belonging to an existing cluster
  ```

**NOTE:** By default escm uses the default AWS credentials configured on your platform. These ***must*** be configured before running this program. If you have multiple sets of credentials, you can select the profile by specifying the profile before the command like so:

```bash
AWS_PROFILE=myprofile ./bin/escm-macos <command>
```

### Create New Cluster
Running

```bash
$ ./bin/escm-macos create-cluster --help
```

Displays the following:

```
Usage: create-cluster|c [options]

Create a new Elasticsearch Cluster

Options:
  -c, --clusterName <nameOfCluster>            Cluster name to be created [required]
  -n, --clusterSize <n>                        Number of nodes in the cluster [required]
  -i, --instanceType <instanceType>            The AWS EC2 instance type to use for nodes
  -r, --iamRole <iamRoleName>                  The name of the IAM Role you want attached to these nodes (must already exist)
  -k, --keyName <keyName>                      The Key Pair name to attach to the instances (will be created if it does not exist)
  -g, --securityGroupId <securityGroupId>      The id of the security group to use (must exist)
  -s, --subnetId <subnetId>                    The subnet to launch these clusters in.
  -m, --remoteMonitoring <true|false>          Whether or not remote monitoring is enabled.
  -o, --monitoringCluster <monitoringCluster>  The ip address of the monitoring cluster node.
  -t, --nodeTags <nodeTags>                    A comma separated list of <Key:Value> pairs.
  -x, --xpackEnabled <true|false>              Whether or not X-Pack is enabled
  -h, --help                                   output usage information
```
To create a new cluster only the clusterName and clusterSize parameters are required. The others have default values.

If you specify an iamRole or securityGroupId they need to already exist. The IAM role must have permissions for EC2 and s3 so that it can run commands during bootstrapping.

If you specify an instance type it must be a valid AWS EC2 instance type that supports nvme storage.

KeyNames that are specified that do not already exist will be created and stored in the elasticsearch-management s3 bucket and locally in your ~/.ssh/ folder.

```bash
$ ./bin/escm-macos create-cluster --clusterName mycluster -s 5 -k ES-NODES-KEY-PAIR
```

The above creates a 5 node cluster named `mycluster`. By default ssh is only possible from nodes with the `elasticsearch-sg` security group attached to them. This security group is created by default if no security group is specified. If a security group is specified, access to those nodes will be dependent on the rules of that security group.

The number of master and data nodes are automatically computed based on the cluster size specified. Each node will be tagged with the following tags:
* ES_CLUSTER_NAME - cluster name specified
* ES_MASTER_ELIGIBLE - whether or not this node is master eligible
* ES_NODE_NAME_PREFIX - `es-<clusterName>-<master|data>-<last octet of private ip address>`
* ES_MINIMUM_MASTER_NODES - the minimum number of master nodes that need to exist for a cluster to form.

Some of the tags above are used during the bootstrapping process of the nodes and are placed into the elasticsearch.yml script. See Boostrap section for more.

### List Instances For A Cluster
```bash
$ ./bin/escm-macos list-cluster-instances --clusterName mycluster
```

Will list all of the instance ids associated with the running cluster.

### Add Cluster Nodes
```bash
$ ./bin/escm-macos add-nodes --clusterName mycluster --numMasterNodes 2 --numDataNodes 4
```

Will add the specified number of master nodes and data nodes to the cluster. numMasterNodes or numDataNodes is required along with the clusterName. You can also specifiy both.

### Remove Cluster Node

```bash
$ ./bin/escm-macos remove-nodes --clusterName mycluster --nodeNames es-mycluster-data-187,es-mycluster-data-143
```

The above command will terminate the instances where the ES_CLUSTER_NAME tag is equal to mycluster and the Name tag is equal to es-mycluster-data-187 and es-mycluster-data-143.

### Destroy A Cluster

```bash
$ ./bin/escm-macos destroy-cluster --clusterName mycluster
```
This command will terminate all of the nodes with a tag of ES_CLUSTER_NAME=mycluster.



## Bootstrap Scripts
----
Much of the documentation for the bootstrap scripts exists inline within the actual scripts themselves. These scripts are provided as `User Data` upon EC2 instance creation and provide all of the bootstrap boilerplate to configure the nodes for Elasticsearch installation. These scripts rely heavily on the tags attached to the instances.

### bootstrap-scripts/bootstrap.sh

In particular, the following tags must be specified:

* ES_CLUSTER_NAME
* ES_MASTER_ELIGIBLE
* ES_NODE_NAME_PREFIX
* ES_MINIMUM_MASTER_NODES
* ES_XPACK_ENABLED

If the above listed tags are not all specified, the node will fail to be started and the escm scripts will not properly work.

To that end, it is important that you leverage the es-cluster-manager for the creation of new nodes.

### bootstrap-scripts/kibana-bootstrap.sh

This bootstrap script is the minimum for creating a Kibana instance that connects to your cluster. The following tags must be specified when using independently:

* KIBANA_INSTANCE_NAME
* ES_HOSTS - should be specified in the format: http://x.xx.xxx.xx:9200

**NOTE**: Currently there are no commands for deploying a kibana instance. This must be done manually, by adding the kibana-bootstrap.sh script to the `User Data` of an instance upon creation.
