const program = require('commander');
const { prompt } = require('inquirer');
const Ec2Manager = require('./ec2Manager');

ec2Manager = new Ec2Manager();


var tracker;

program
  .version('1.0.0')
  .description("Elasticsearch Cluster Manager")
  .option('--esHostname <esHostname>', 'specify an elasticsearch host name for the management tracker')
  .option('--esPort <esPort>', 'specify an elasticsearch port for the management tracker')
  .option('--esUsername <esUsername>', 'specify a user name for elasticsearch authentication')
  .option('--esPassword <esPassword>', 'specify a password for elasticsearch authentication')
  .option('--esProtocol <esProtocol>', 'specify a protocol for connecting to elasticsearch')

/**create cluster command */
program
  .command('create-cluster')
  .option('-c, --clusterName <nameOfCluster>', 'Cluster name to be created [required]')
  .option('-n, --clusterSize <n>', 'Number of nodes in the cluster [required]', parseInt)
  .option('-i, --instanceType <instanceType>', 'The AWS EC2 instance type to use for nodes')
  .option('-r, --iamRole <iamRoleName>', 'The name of the IAM Role you want attached to these nodes (must already exist)')
  .option('-k, --keyName <keyName>', 'The Key Pair name to attach to the instances (will be created if it does not exist)')
  .option('-g, --securityGroupId <securityGroupId>', 'The id of the security group to use (must exist)')
  .option('-s, --subnetId <subnetId>', 'The subnet to launch these clusters in.')
  .option('-m, --remoteMonitoring <true|false>', 'Whether or not remote monitoring is enabled.')
  .option('-o, --monitoringCluster <monitoringCluster>', "The ip address of the monitoring cluster node.")
  .option('-t, --nodeTags <nodeTags>', "A comma separated list of <Key:Value> pairs.")
  .option('-x, --xpackEnabled <true|false>', 'Whether or not X-Pack is enabled')
  .alias('c')
  .description("Create a new Elasticsearch Cluster")
  .action((cmd) => {

    if (!cmd.clusterName || !cmd.clusterSize) {
      throw new Error('--clusterName and --clusterSize options required to create a cluster.');
      process.exit(1);
    }
    var params = {
      clusterName: cmd.clusterName, /*required*/
      clusterSize: cmd.clusterSize, /*required*/
      instanceType: cmd.instanceType,
      iamRole: cmd.iamRole,
      keyName: cmd.keyName,
      securityGroupId: cmd.securityGroupId,
      subnetId: cmd.subnetId,
      xpackEnabled: cmd.xpackEnabled,
      monitoringCluster: cmd.monitoringCluster,
      remoteMonitoring: cmd.remoteMonitoring,
      nodeTags: cmd.nodeTags ? cmd.nodeTags.split(",") : null
    }
    ec2Manager.createNewCluster(params, function(err, response) {
      if (err) {
        console.log("Failed to create cluster...");
        console.log(err);
      } else {
        console.log(response);
      }
    })
  });


/**list a specified parameter for cluster instances**/
program
  .command('list-cluster-params')
  .option('-c, --clusterName <nameOfCluster>', 'Cluster name to list param for [required]')
  .option('-p, --parameterName <parameterName>', 'Parameter you want listed for each node [required]')
  .description('List a specific parameter for all of the instances in an existing cluster')
  .action((cmd) => {
    ec2Manager.getClusterNodeParameter(cmd.clusterName, cmd.parameterName).then(function(params) {
      console.log("Cluster " + cmd.parameterName + "s: " + params.toString());
    })
    .catch(function(err) {
      console.log("Error finding cluster instances");
      console.log(err);
    })
  });

/**list cluster instances command **/
program
  .command('list-cluster-instances')
  .option('-c, --clusterName <nameOfCluster>', 'Cluster name to list instances for [required]')
  .alias('l')
  .description("List the instance ids of an existing cluster")
  .action((cmd) => {
    ec2Manager.getClusterInstanceIds(cmd.clusterName).then(function(instanceIds) {
      console.log("Cluster Instance Ids: " + instanceIds.toString());
    })
    .catch(function(err) {
      console.log("Error finding cluster instances.");
      console.log(err);
    })
  });

/**destroy cluster command **/
program
  .command('destroy-cluster')
  .option('-c, --clusterName <nameOfCluster>', 'Cluster name to destroy [required]')
  .alias('d')
  .description('Destroys an existing cluster with the name specified')
  .action(cmd => {
    if (!cmd.clusterName) {
      throw new Error('The --clusterName flag is required to destroy a cluster.');
      process.exit(1);
    }
    ec2Manager.destroyCluster(cmd.clusterName).then(function(result) {
      console.log(result);
    })
    .catch(function(err) {
        console.log("Error deleting cluster:");
        console.log(err);
    });
  });

program
  .command('add-nodes')
  .option('-c, --clusterName <nameOfCluster>', 'Cluster name to add nodes to [required]')
  .option('-m, --numMasterNodes <n>', 'Number of master nodes to add to the cluster', parseInt)
  .option('-d, --numDataNodes <n>', 'Number of data nodes to add to the cluster')
  .option('-r, --numClientNodes <n>', 'Number of client nodes to add to the cluster')
  .option('-i, --instanceType <instanceType>', 'The instance type to use for newly added nodes')
  .alias('a')
  .description("Add a new nodes to an existing cluster.")
  .action((cmd) => {
    if (!cmd.clusterName) {
      throw new Error('Cluster name must be specified with the --clusterName flag');
      process.exit(1);
    }
    if (!cmd.numMasterNodes && !cmd.numDataNodes && !cmd.numClientNodes) {
      throw new Error('Either numMasterNodes, numDataNodes or both must be specified');
      process.exit(1);
    }
    var params = {
      clusterName: cmd.clusterName,
      numMasterNodes: cmd.numMasterNodes,
      numDataNodes: cmd.numDataNodes,
      numClientNodes: cmd.numClientNodes,
      instanceType: cmd.instanceType
    }
    ec2Manager.addClusterNodes(params).then(function(result) {
      console.log(result)
    })
    .catch(function(err) {
      console.log("Error adding nodes to the cluster.");
      console.log(err);
    });
  });

program
  .command('remove-nodes')
  .option('-c, --clusterName <nameOfCluster>', 'Cluster name to remove nodes from [required]')
  .option('-n, --nodeNames <nodeNameList>', 'A comma separated list of ndoe names to remove from the cluster [required]')
  .alias('r')
  .description('Remove a list of nodes belonging to an existing cluster')
  .action((cmd) => {
    if (!cmd.clusterName || !cmd.nodeNames) {
      throw new Error('the --clusterName and --nodeNames flags are required to remove a node');
      process.exit(1);
    }
    var params = {clusterName: cmd.clusterName, nodeNames: cmd.nodeNames}
    ec2Manager.removeClusterNodes(params).then(function(result) {
      console.log(result);
    })
    .catch(function(err) {
      console.log("Error removing nodes from the cluster");
      console.log(err);
    });
  });

program.parse(process.argv)
