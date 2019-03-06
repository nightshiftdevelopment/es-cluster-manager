const AWS = require('aws-sdk');
const defaultAMI = "ami-02da3a138888ced85";
const fs = require('fs');
const path = require('path');
const _ = require('lodash');


class EC2Manager {

  constructor(options={}) {
    AWS.config.update({region: 'us-east-1'});

    this.ec2Api = new AWS.EC2();


    this.defaultESNodeParams = {
      ImageId: defaultAMI,
      InstanceType: 'i3.large',
      MinCount: 1, MaxCount: 1,
      KeyName: null,
      SecurityGroupIds: [],
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: []
        }
      ]
    }
  }

  __getBootstrapFile() {
    return new Promise((resolve, reject) => {

      var bootstrapFilePath = path.join(__dirname, 'bootstrap-scripts/bootstrap.sh')
      fs.readFile(bootstrapFilePath, 'utf8', function(err, contents) {
        if (!err) {
          var bootstrapFile = new Buffer(contents).toString('base64');

          resolve(bootstrapFile);
        } else {
          reject(err);
        }
      });
    });
  }

  __saveKeyPair(keyName, keyData) {
    return new Promise((resolve, reject) => {
      fs.writeFileSync('~/.ssh/' + keyName + '.pem', keyData);
      resolve(true);
    });
  }

  async createKeyPair(keyName, cb) {
    return new Promise(async (resolve, reject) => {
      this.ec2Api.createKeyPair({KeyName: keyName }, async function(err, data) {
        if (err) {
          //TODO: maybe try creating a derivative keyname with date instead of making this assumption?
          if (err.code == 'InvalidKeyPair.Duplicate') { //key already exists so we assume we've saved it before and move on
            resolve(true);
          } else {
            reject(err);
          }
        } else {
          resolve(data.KeyMaterial);
        }
      });
    });
  }

  createNewCluster(options, cb) {

    var clusterName = options.clusterName;
    var clusterSize = options.clusterSize;
    var remoteMonitoring = options.remoteMonitoring || "false";
    var monitoringCluster = options.monitoringCluster || null;

    var esNodeParams = _.cloneDeep(this.defaultESNodeParams);

    if (options.instanceType) {
      esNodeParams.InstanceType = options.instanceType;
    }

    if (options.iamRole) {
      esNodeParams.IamInstanceProfile = {
        Name: options.iamRole
      }
    }

    if (options.subnetId) {
      esNodeParams.SubnetId = options.subnetId
    }

    var xpack_setting = 'false'; //defau;t
    if (options.xpackEnabled) {
      if (['true','false'].includes(options.xpackEnabled)) {
        xpack_setting = options.xpackEnabled;
      } else {
        xpack_setting = 'false';
      }
    }

    var keyName = options.keyName || clusterName + "-key";


    Promise.all([this.createKeyPair(keyName), options.securityGroupId || this.getSecurityGroupId(), this.__getBootstrapFile()])
      .then(async (values) => {
        var keyData = values[0];
        esNodeParams.KeyName = keyName;
        if (keyData != true) { //this is a new key so let's store it
          //save the key pair locally
          this.__saveKeyPair(keyName, keyData);
        }


        //add the security groups
        esNodeParams.SecurityGroupIds.push(values[1]);

        //add user data..
        esNodeParams.UserData = values[2];

        //figure out number of masters and data nodes
        var numMasters = Math.min(clusterSize, 3);
        console.log("Num masters: " + numMasters);
        var numDataNodes = clusterSize - numMasters;
        console.log("Num data: " + numDataNodes);

        //figure out minimum master nodes required for cluster
        var minimum_master_nodes = parseInt(numMasters / 2 + 1);


        //set the tags for master nodes
        var tags = [];
        tags.push({Key: "ES_CLUSTER_NAME", Value: clusterName });
        tags.push({Key: "ES_NODE_NAME_PREFIX", Value: "es-" + clusterName + "-master"});
        tags.push({Key: "Name", Value: "es-" + clusterName + "-master"});
        tags.push({Key: "ES_MASTER_ELIGIBLE", Value: 'true'});
        tags.push({Key: "ES_MINIMUM_MASTER_NODES", Value: ""+minimum_master_nodes });
        tags.push({Key: "ES_XPACK_ENABLED", Value: xpack_setting });

        //push any user defined tags
        if (options.nodeTags) {
          options.nodeTags.map(nodeTag => {
            var kv = nodeTag.split(":");
            if (kv.length != 2) {
              return;
            } else {
              tags.push({Key: kv[0], Value: kv[1]});
            }
          })
        }

        if (remoteMonitoring == "true" && monitoringCluster != null) {
          tags.push({Key: "ES_REMOTE_MONITORING", Value: 'true'});
          tags.push({Key: "ES_MONITORING_CLUSTER", "Value": monitoringCluster});
        }

        esNodeParams.TagSpecifications[0].Tags = tags;
        esNodeParams.MinCount = numMasters;
        esNodeParams.MaxCount = numMasters;

        //wait for masters to be created
        this.createNewNodes(esNodeParams).then((mastersResult) => {

          //set the tags for data nodes
          var tags = [];
          tags.push({Key: "ES_CLUSTER_NAME", Value: clusterName });
          tags.push({Key: "ES_NODE_NAME_PREFIX", Value: "es-" + clusterName + "-data"});
          tags.push({Key: "Name", Value: "es-" + clusterName + "-data"});
          tags.push({Key: "ES_MASTER_ELIGIBLE", Value: 'false'});
          tags.push({Key: "ES_MINIMUM_MASTER_NODES", Value: ""+minimum_master_nodes});
          tags.push({Key: "ES_XPACK_ENABLED", Value: xpack_setting });

          if (remoteMonitoring == "true" && monitoringCluster != null) {
            tags.push({Key: "ES_REMOTE_MONITORING", Value: 'true'});
            tags.push({Key: "ES_MONITORING_CLUSTER", "Value": monitoringCluster});
          }

          //push any user defined tags
          if (options.nodeTags) {
            options.nodeTags.map(nodeTag => {
              var kv = nodeTag.split(":");
              if (kv.length != 2) {
                return;
              } else {
                tags.push({Key: kv[0], Value: kv[1]});
              }
            })
          }

          esNodeParams.TagSpecifications[0].Tags = tags;
          esNodeParams.MinCount = numDataNodes;
          esNodeParams.MaxCount = numDataNodes;

          this.createNewNodes(esNodeParams)
            .then((dataNodeResults) => {
              cb(null, "Successfully Created ES Cluster: " + clusterName);
            })
            .catch((dataNodesErr) => {
              cb(dataNodesErr, null);
            });
        })
        .catch((masterCreationErr) => {
          cb(masterCreationErr, null);
        });
      })
      .catch(err => {
        cb(err, null);
      });
  }

  destroyCluster(clusterName) {
    return new Promise((resolve, reject) => {
      this.getClusterInstanceIds(clusterName).then((instanceIds) => {
        if (instanceIds.length > 0) {
          var params = {InstanceIds: instanceIds}
          this.ec2Api.terminateInstances(params, function(err, data) {
            if (!err) {
              resolve("Successfully destroyed cluster [" + clusterName + "].");
            } else {
              reject(err);
            }
          });
        } else {
          resolve("No Cluster Instances To Delete with Cluster Name: " + clusterName);
        }
      })
      .catch (err => {
        reject(err);
      });
    });
  }

  getClusterInstanceIds(clusterName, additionalFilters=null) {
    return new Promise(async (resolve, reject) => {
      try {
        var instances = await this.__findClusterInstances(clusterName, additionalFilters);
        var instanceIds = [];
        instances.forEach(instance => {
          instanceIds.push(instance.InstanceId);
        });
        resolve(instanceIds);
      } catch (e) {
        reject(e);
      }
    });
  }

  getClusterNodeParameter(clusterName, paramName, additionalFilters=null) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log(paramName);
        var instances = await this.__findClusterInstances(clusterName, additionalFilters);
        var instanceParams = []
        instances.forEach(instance => {
          instanceParams.push(instance[paramName])
        });
        resolve(instanceParams);
      } catch(e) {
        reject(e);
      }
    });
  }

  __findClusterInstances(clusterName, additionalFilters=null) {
    return new Promise((resolve, reject) => {
      var params = {
        Filters: [
          {
            Name: "instance-state-name",
            Values: ["running"]
          },
          {
            Name: "tag:ES_CLUSTER_NAME",
            Values: [clusterName]
          }
        ]
      };

      if (additionalFilters) {
        params.Filters.push(...additionalFilters);
      }

      this.ec2Api.describeInstances(params, function(err, data) {
        if (err) {
          reject(err);
        } else {
          var reservations = data.Reservations;
          var allInstances = [];
          if (reservations.length == 0) {
            resolve([]);
          } else {
            reservations.forEach(function(reservation) {
              if (reservation.Instances && reservation.Instances.length > 0){
                reservation.Instances.forEach(function(instance) {
                  allInstances.push(instance);
                });
              }
            });
            resolve(allInstances);
          }
        }
      })

    });
  }

  __checkSecurityGroupExists() {
    return new Promise(async (resolve, reject) => {
      var params = { GroupNames: [ 'elasticsearch-sg'] }
      this.ec2Api.describeSecurityGroups(params, function(err, data) {
          if (err) {
            if (err.code == 'InvalidGroup.NotFound') {
              resolve(false)
            } else {
              reject(err)
            }
          } else {
            resolve(data.SecurityGroups[0].GroupId)
          }
      });
    });
  }

  __doCreateSecurityGroup() {
    return new Promise(async (resolve, reject) => {
      var params = {Description: 'Security Group For Elasticsearch Node access', GroupName: 'elasticsearch-sg'};
      this.ec2Api.createSecurityGroup(params, function(err, data) {
        if (err) {
          if (err.code == 'InvalidGroup.Duplicate') {
            resolve(true);
          } else {
            reject(err);
          }
        } else {
          resolve(data.GroupId);
        }
      });
    });

  }

  __doAuthorizePortsForSecurityGroup(sg) {
    return new Promise(async (resolve, reject) => {
      var PortParams = {
        GroupId: sg,
        IpPermissions: [
          {
            FromPort:9200,
            ToPort:9200,
            IpProtocol: 'tcp',
            UserIdGroupPairs: [
              {GroupId: sg}
            ]
          },
          {
            FromPort:9300,
            ToPort:9300,
            IpProtocol: 'tcp',
            UserIdGroupPairs: [
              {GroupId: sg}
            ]
          },
          {
            FromPort: 22,
            ToPort: 22,
            IpProtocol: 'tcp',
            UserIdGroupPairs: [
              {GroupId: sg}
            ]
          }
        ]
      }
      this.ec2Api.authorizeSecurityGroupIngress(PortParams, function(err, data) {
        if (err) {
          reject(err);
        } else {
          resolve(true);
        }
      });
    });
  }

  async getSecurityGroupId() {
    return new Promise(async (resolve, reject) => {
      try {
        var groupId = await this.__checkSecurityGroupExists();
        if (groupId) {
          //we assume ports are already set
          resolve(groupId)
        } else { //we need to create it.
          var sgID = await this.__doCreateSecurityGroup();
          var portsSet = await this.__doAuthorizePortsForSecurityGroup(sgID);

          if (portsSet) {
            resolve(sgID);
          }
        }
      } catch(e) {
        reject(e);
      }
    });

  }

  removeClusterNodes(options) {
    return new Promise((resolve, reject) => {
      var clusterName = options.clusterName;
      var nodeNames = options.nodeNames.split(',');

      var filters = [ {
        Name: 'tag:Name',
        Values: nodeNames
      }];
      this.getClusterInstanceIds(clusterName, filters).then(instanceIds => {
        if (instanceIds.length > 0) {
          var params = {InstanceIds: instanceIds};
          this.ec2Api.terminateInstances(params, function(err, data) {
            if (!err) {
              resolve("Successfully removed " + instanceIds.length  + " nodes from cluster [" + clusterName + "]");
            } else {
              reject(err);
            }
          });
        } else {
          resolve("Could not find [" + nodeNames + "] in cluster [" + clusterName + "].");
        }
      })
      .catch(err => {
        reject(err);
      });
    });
  }

  /**This is only for adding nodes to an existing cluster**/
  addClusterNodes(options) {
    return new Promise(async (resolve, reject) => {
      var numMasters = options.numMasterNodes || 0;
      var numDataNodes =options.numDataNodes || 0;
      var numClientNodes = options.numClientNodes || 0;

      var clusterName = options.clusterName;

      var xpack_setting = 'false'; //default
      if (options.xpackEnabled) {
        if (['true','false'].includes(options.xpackEnabled)) {
          xpack_setting = options.xpackEnabled;
        } else {
          xpack_setting = 'false';
        }
      }

      try{
        var clusterInstances = await this.__findClusterInstances(clusterName);
        clusterInstances = clusterInstances.filter(i => i.State.Name !='terminated');
        if (clusterInstances.length ==0) {
          resolve("Could not add nodes to cluster [" + options.clusterName + "]. Cluster does not exist.");
          return;
        } else {

          var keyName = clusterInstances[0].KeyName;
          var securityGroupIds = clusterInstances[0].SecurityGroups.map(sg => sg.GroupId);

          //new nodes should inherit these settings
          var minimum_master_nodes = clusterInstances[0].Tags.filter(tag => tag.Key =="ES_MINIMUM_MASTER_NODES")[0].Value;
          var xpack_setting = clusterInstances[0].Tags.filter(tag => tag.Key =="ES_XPACK_ENABLED")[0].Value;

          //we can add these new nodes;
          var esNodeParams = _.cloneDeep(this.defaultESNodeParams);
          esNodeParams.KeyName = keyName;
          esNodeParams.SecurityGroupIds.push(...securityGroupIds);

          if (options.instanceType) {
            esNodeParams.InstanceType = options.instanceType;
          }

          this.__getBootstrapFile().then(bootstrapFile => {
            esNodeParams.UserData = bootstrapFile;

            var masterParams = _.cloneDeep(esNodeParams);
            var dataParams = _.cloneDeep(esNodeParams);
            var clientParams = _.cloneDeep(esNodeParams);

            //set the master node tags
            var tags = [];
            tags.push({Key: "ES_CLUSTER_NAME", Value: clusterName });
            tags.push({Key: "ES_NODE_NAME_PREFIX", Value: "es-" + clusterName + "-master"});
            tags.push({Key: "Name", Value: "es-" + clusterName + "-master"});
            tags.push({Key: "ES_MASTER_ELIGIBLE", Value: 'true'});
            tags.push({Key: "ES_MINIMUM_MASTER_NODES", Value: ""+minimum_master_nodes });
            tags.push({Key: "ES_XPACK_ENABLED", Value: xpack_setting });

            masterParams.TagSpecifications[0].Tags = tags;
            masterParams.MinCount = numMasters;
            masterParams.MaxCount = numMasters;

            //set the tags for data nodes
            var dtags = [];
            dtags.push({Key: "ES_CLUSTER_NAME", Value: clusterName });
            dtags.push({Key: "ES_NODE_NAME_PREFIX", Value: "es-" + clusterName + "-data"});
            dtags.push({Key: "Name", Value: "es-" + clusterName + "-data"});
            dtags.push({Key: "ES_MASTER_ELIGIBLE", Value: 'false'});
            dtags.push({Key: "ES_MINIMUM_MASTER_NODES", Value: ""+minimum_master_nodes});
            dtags.push({Key: "ES_XPACK_ENABLED", Value: xpack_setting });

            dataParams.TagSpecifications[0].Tags = dtags;
            dataParams.MinCount = numDataNodes;
            dataParams.MaxCount = numDataNodes;

            //set the tags for client nodes
            var ctags = [];
            ctags.push({Key: "ES_CLUSTER_NAME", Value: clusterName });
            ctags.push({Key: "ES_NODE_NAME_PREFIX", Value: "es-" + clusterName + "-client"});
            ctags.push({Key: "Name", Value: "es-" + clusterName + "-client"});
            ctags.push({Key: "ES_MASTER_ELIGIBLE", Value: 'false'});
            ctags.push({Key: "ES_DATA_ELIGIBLE", Value: 'false'});
            ctags.push({Key: "ES_INGEST_ELIGIBLE", Value: 'false'});
            ctags.push({Key: "ES_CROSS_CLUSTER_ELIGIBLE", Value: 'false'});
            ctags.push({Key: "ES_MINIMUM_MASTER_NODES", Value: ""+minimum_master_nodes});
            ctags.push({Key: "ES_XPACK_ENABLED", Value: xpack_setting });

            clientParams.TagSpecifications[0].Tags = ctags;
            clientParams.MinCount = numClientNodes;
            clientParams.MaxCount = numClientNodes;


            Promise.all([this.createNewNodes(masterParams), this.createNewNodes(dataParams), this.createNewNodes(clientParams)]).then(res => {
              resolve("Sucessfully added new nodes");
            })
            .catch(err=> {
              reject(err);
            });
          });
        }
      } catch(e) {
        reject(e);
      }
    });
  }

  createNewNodes(nodeParameters) {
    return new Promise(async (resolve, reject) => {

      if (nodeParameters.MinCount ==0 && nodeParameters.MaxCount == 0) {
        resolve();

      } else {
        this.ec2Api.runInstances(nodeParameters, function(err, res) {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        });
      }

    });
  }
}

module.exports=EC2Manager;
